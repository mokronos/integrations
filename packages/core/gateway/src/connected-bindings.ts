import type { IntegrationsApi } from "@mokronos/integrations"
import { Effect } from "effect"
import {
  Alias,
  ConnectionName,
  connectionRefKey,
  type ConnectionRef,
  IntegrationSlug,
  type Policy,
  type PolicyTool,
  ToolName,
  type Client
} from "./domain.ts"
import { newClientToolBindingId } from "./keys.ts"
import { type GatewayStore, GatewayStoreError } from "./store.ts"

interface PolicyCatalog {
  readonly tools: Pick<IntegrationsApi["tools"], "summaries">
  readonly connections: Pick<IntegrationsApi["connections"], "list">
}

const aliasFor = (integration: string): Alias =>
  Alias.make(integration.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, ""))

/** Reconciles every policy with the connected catalog. The default explicitly
 * contains every connected integration; custom policies only gain missing
 * tools beneath memberships an operator already chose. Existing enabled states
 * and decisions are never rewritten. */
export const reconcilePolicyConfigurations = Effect.fn(
  "ConnectedBindings.reconcilePolicyConfigurations"
)(
  function*(input: {
    readonly store: GatewayStore
    readonly integrations: PolicyCatalog
    readonly tenantId: Client["tenantId"]
  }): Effect.fn.Return<void, GatewayStoreError> {
    const policies = yield* input.store.listPolicies(input.tenantId)
    const [summaries, connections] = yield* Effect.all([
      Effect.promise(() => input.integrations.tools.summaries()),
      Effect.promise(() => input.integrations.connections.list())
    ])
    const catalogIntegrations = new Set(connections.map((connection) => connection.integration))
    const catalogTools = new Map<string, {
      readonly connection: Extract<ConnectionRef, { readonly owner: "org" }>
      readonly tool: ToolName
      readonly decision: "allow" | "require_approval"
    }>()
    for (const summary of summaries) {
      // Only org-tier connections are reconciled into shared policies. A
      // user-tier connection is one human's authorization; putting it in a
      // policy several clients share would hand it to all of them.
      if (summary.owner !== "org") continue
      const connection = {
        owner: "org",
        integration: IntegrationSlug.make(summary.integration),
        name: ConnectionName.make(summary.connection)
      } as const
      const key = `${connectionRefKey(connection)}\u0000${summary.name}`
      const existing = catalogTools.get(key)
      catalogTools.set(key, {
        connection,
        tool: ToolName.make(summary.name),
        decision: existing?.decision === "require_approval" || summary.defaultDecision === "require_approval"
          ? "require_approval"
          : "allow"
      })
    }
    yield* Effect.forEach(policies, (policy) => Effect.gen(function*() {
      const [existingMemberships, existingTools] = yield* Effect.all([
        input.store.listPolicyIntegrations(policy.id),
        input.store.listPolicyTools(policy.id)
      ])
      const memberships = new Set(existingMemberships.map((entry) => entry.integration))
      if (policy.isDefault) {
        for (const integration of catalogIntegrations) {
          memberships.add(IntegrationSlug.make(integration))
        }
      }
      const tools = new Map(existingTools.map((tool) => [
        `${connectionRefKey(tool.connection)}\u0000${tool.tool}`,
        {
          connection: tool.connection,
          tool: tool.tool,
          enabled: tool.enabled,
          decision: tool.decision
        }
      ]))
      for (const [key, catalogTool] of catalogTools) {
        if (!memberships.has(catalogTool.connection.integration) || tools.has(key)) continue
        tools.set(key, {
          connection: catalogTool.connection,
          tool: catalogTool.tool,
          enabled: true,
          decision: catalogTool.decision
        })
      }
      const membershipChanged = memberships.size !== existingMemberships.length
      const toolsChanged = tools.size !== existingTools.length
      if (membershipChanged || toolsChanged) {
        yield* input.store.replacePolicyConfiguration(policy.id, {
          integrations: [...memberships],
          tools: [...tools.values()]
        })
      }
    }), { discard: true })
  }
)

/** Reconciles all policies and returns the built-in default for callers that
 * need to assign it to a new client. */
export const ensureDefaultPolicyTools = Effect.fn("ConnectedBindings.ensureDefaultPolicyTools")(
  function*(input: {
    readonly store: GatewayStore
    readonly integrations: PolicyCatalog
    readonly tenantId: Client["tenantId"]
  }): Effect.fn.Return<Policy | undefined, GatewayStoreError> {
    yield* reconcilePolicyConfigurations(input)
    return yield* input.store.findDefaultPolicy(input.tenantId)
  }
)

/** The public name a client calls one connection's tools by. A single
 * connection per integration keeps the plain slug, so the common setup reads
 * `linear.list_issues`. Once a policy carries more than one connection for the
 * same integration the name has to say which credential it means, so every
 * route for that integration is qualified — `linear-work.list_issues` and
 * `linear-personal.list_issues` — rather than one silently winning. */
const routeAliases = (
  rules: ReadonlyArray<PolicyTool>
): ReadonlyMap<string, Alias> => {
  const connectionsPerIntegration = new Map<string, Set<string>>()
  for (const rule of rules) {
    const names = connectionsPerIntegration.get(rule.connection.integration) ?? new Set<string>()
    names.add(connectionRefKey(rule.connection))
    connectionsPerIntegration.set(rule.connection.integration, names)
  }
  const aliases = new Map<string, Alias>()
  for (const rule of rules) {
    const ambiguous = (connectionsPerIntegration.get(rule.connection.integration)?.size ?? 0) > 1
    aliases.set(
      connectionRefKey(rule.connection),
      aliasFor(ambiguous
        ? `${rule.connection.integration}-${rule.connection.name}`
        : rule.connection.integration)
    )
  }
  return aliases
}

const routeKey = (alias: Alias, tool: ToolName, connection: ConnectionRef): string =>
  [alias, tool, connectionRefKey(connection)].join("\u0000")

/** Makes a client's callable routes exactly mirror its assigned policy.
 *
 * The two concepts stay distinct — a policy decides whether an operation is
 * allowed, a binding decides which credential it reaches and what the client
 * calls it — but they are no longer maintained by hand on opposite sides of
 * the gateway. Assigning or editing a policy is the single operation, and the
 * routes follow from it. Only enabled rules become routes: a disabled rule is
 * the operator saying this client should not reach that tool at all.
 *
 * Unchanged routes keep their binding id, so pending approvals and audit rows
 * that point at them survive an unrelated edit elsewhere in the policy. */
export const synchronizeClientBindings = Effect.fn(
  "ConnectedBindings.synchronizeClientBindings"
)(function*(input: {
  readonly store: GatewayStore
  readonly client: Client
}): Effect.fn.Return<void, GatewayStoreError> {
  const [policyTools, existing] = yield* Effect.all([
    input.store.listPolicyTools(input.client.policyId),
    input.store.listBindings(input.client.id)
  ])
  const enabled = policyTools.filter((rule) => rule.enabled)
  const aliases = routeAliases(enabled)
  const desired = new Map(enabled.map((rule) => {
    const alias = aliases.get(connectionRefKey(rule.connection)) ?? aliasFor(rule.connection.integration)
    return [routeKey(alias, rule.tool, rule.connection), {
      alias,
      tool: rule.tool,
      connection: rule.connection
    }] as const
  }))
  const kept = new Set<string>()
  const stale = existing.filter((binding) => {
    const key = routeKey(binding.alias, binding.tool, binding.connection)
    if (!desired.has(key)) return true
    kept.add(key)
    return false
  })
  // Revocation runs to completion before any route is created: an alias that
  // moves to another connection would otherwise collide with itself under the
  // live uniqueness index. Revoking rather than deleting keeps the approval
  // and audit history that points at the old binding readable.
  yield* Effect.forEach(stale, (binding) =>
    input.store.revokeBinding(input.client.tenantId, binding.id), { discard: true })
  yield* Effect.forEach(
    [...desired].filter(([key]) => !kept.has(key)).map(([, route]) => route),
    (route) =>
      input.store.createBinding({
        id: newClientToolBindingId(),
        tenantId: input.client.tenantId,
        clientId: input.client.id,
        alias: route.alias,
        tool: route.tool,
        connection: route.connection
      }),
    { discard: true }
  )
})

/** Applies a changed policy to every live client assigned to it. */
export const synchronizeAssignedPolicyBindings = Effect.fn(
  "ConnectedBindings.synchronizeAssignedPolicyBindings"
)(function*(input: {
  readonly store: GatewayStore
  readonly policy: Policy
}): Effect.fn.Return<void, GatewayStoreError> {
  const clients = yield* input.store.listClients(input.policy.tenantId)
  yield* Effect.forEach(
    clients.filter((client) => client.policyId === input.policy.id && client.revokedAt === null),
    (client) => synchronizeClientBindings({ store: input.store, client }),
    { discard: true }
  )
})

/** Re-derives routes for every live client of a tenant. Used after the catalog
 * itself moves — a new connection, or a tool that disappeared — where the
 * policies that changed are not known individually. */
export const synchronizeTenantBindings = Effect.fn(
  "ConnectedBindings.synchronizeTenantBindings"
)(function*(input: {
  readonly store: GatewayStore
  readonly tenantId: Client["tenantId"]
}): Effect.fn.Return<void, GatewayStoreError> {
  const clients = yield* input.store.listClients(input.tenantId)
  yield* Effect.forEach(
    clients.filter((client) => client.revokedAt === null),
    (client) => synchronizeClientBindings({ store: input.store, client }),
    { discard: true }
  )
})

/** What a newly connected credential means for delegated access: the default
 * policy gains the integration, every policy that already contains it gains
 * the missing tools, and every client's routes are re-derived from that. One
 * call, so no caller can do half of it. */
export const synchronizeConnectedCatalog = Effect.fn(
  "ConnectedBindings.synchronizeConnectedCatalog"
)(function*(input: {
  readonly store: GatewayStore
  readonly integrations: PolicyCatalog
  readonly tenantId: Client["tenantId"]
}): Effect.fn.Return<void, GatewayStoreError> {
  yield* reconcilePolicyConfigurations(input)
  yield* synchronizeTenantBindings({ store: input.store, tenantId: input.tenantId })
})

/** Removes every policy rule that names a connection that no longer exists and
 * re-derives routes from what is left. A deleted credential must not leave a
 * rule that still reads as live in the dashboard while resolving to nothing
 * when a client calls it. */
export const forgetConnectionRules = Effect.fn(
  "ConnectedBindings.forgetConnectionRules"
)(function*(input: {
  readonly store: GatewayStore
  readonly tenantId: Client["tenantId"]
  readonly integration: string
  readonly connection: string
}): Effect.fn.Return<void, GatewayStoreError> {
  const policies = yield* input.store.listPolicies(input.tenantId)
  yield* Effect.forEach(policies, (policy) =>
    Effect.gen(function*() {
      const [memberships, tools] = yield* Effect.all([
        input.store.listPolicyIntegrations(policy.id),
        input.store.listPolicyTools(policy.id)
      ])
      const remaining = tools.filter((rule) =>
        rule.connection.integration !== input.integration ||
        rule.connection.name !== input.connection)
      if (remaining.length === tools.length) return
      yield* input.store.replacePolicyConfiguration(policy.id, {
        integrations: memberships.map((entry) => entry.integration),
        tools: remaining.map((rule) => ({
          connection: rule.connection,
          tool: rule.tool,
          enabled: rule.enabled,
          decision: rule.decision
        }))
      })
    }), { discard: true })
  yield* synchronizeTenantBindings({ store: input.store, tenantId: input.tenantId })
})
