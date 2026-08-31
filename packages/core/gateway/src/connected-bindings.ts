import type { IntegrationsApi } from "@mokronos/integrations"
import { Effect } from "effect"
import {
  Alias,
  ConnectionName,
  IntegrationSlug,
  type Policy,
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
      readonly integration: IntegrationSlug
      readonly tool: ToolName
      readonly decision: "allow" | "require_approval"
    }>()
    for (const summary of summaries) {
      const key = `${summary.integration}\u0000${summary.name}`
      const existing = catalogTools.get(key)
      catalogTools.set(key, {
        integration: IntegrationSlug.make(summary.integration),
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
        `${tool.integration}\u0000${tool.tool}`,
        {
          integration: tool.integration,
          tool: tool.tool,
          enabled: tool.enabled,
          decision: tool.decision
        }
      ]))
      for (const [key, catalogTool] of catalogTools) {
        if (!memberships.has(catalogTool.integration) || tools.has(key)) continue
        tools.set(key, {
          integration: catalogTool.integration,
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

/** Adds a newly connected integration to the default and reconciles missing
 * tools for every policy that already contains that integration. */
export const includeConnectedToolsInDefaultPolicy = Effect.fn(
  "ConnectedBindings.includeConnectedToolsInDefaultPolicy"
)(function*(input: {
  readonly store: GatewayStore
  readonly integrations: PolicyCatalog
  readonly tenantId: Client["tenantId"]
  readonly integration: string
  readonly connection: string
}): Effect.fn.Return<void, GatewayStoreError> {
  yield* reconcilePolicyConfigurations({
    store: input.store,
    integrations: input.integrations,
    tenantId: input.tenantId
  })
})

/** Gives a new client an immediately useful route for every current org tool. */
export const bindCurrentOrgTools = Effect.fn("ConnectedBindings.bindCurrentOrgTools")(function*(input: {
  readonly store: GatewayStore
  readonly integrations: Pick<IntegrationsApi, "tools">
  readonly client: Client
}): Effect.fn.Return<void, GatewayStoreError> {
  const summaries = yield* Effect.promise(() => input.integrations.tools.summaries())
  const seen = new Set<string>()
  yield* Effect.forEach(summaries.filter((tool) => {
    const key = `${tool.integration}\u0000${tool.name}`
    if (tool.owner !== "org" || seen.has(key)) return false
    seen.add(key)
    return true
  }), (tool) => input.store.createBinding({
    id: newClientToolBindingId(),
    tenantId: input.client.tenantId,
    clientId: input.client.id,
    alias: aliasFor(tool.integration),
    tool: ToolName.make(tool.name),
    connection: {
      owner: "org",
      integration: IntegrationSlug.make(tool.integration),
      name: ConnectionName.make(tool.connection)
    }
  }), { discard: true })
})

/** Adds client-local routes for newly connected tools. Shared policy rules are
 * intentionally untouched: provisioning a connection cannot widen authority. */
export const bindConnectedTools = Effect.fn("ConnectedBindings.bindConnectedTools")(function*(input: {
  readonly store: GatewayStore
  readonly integrations: Pick<IntegrationsApi, "tools">
  readonly client: Client
  readonly integration: string
  readonly connection: string
}): Effect.fn.Return<void, GatewayStoreError> {
  const alias = aliasFor(input.integration)
  const [tools, existing] = yield* Effect.all([
    Effect.promise(() => input.integrations.tools.summaries({
      integration: input.integration,
      connection: input.connection
    })),
    input.store.listBindings(input.client.id)
  ])
  yield* Effect.forEach(
    tools.filter((tool) =>
      tool.owner === "org" &&
      tool.connection.toLowerCase() === input.connection.toLowerCase() &&
      !existing.some((binding) => binding.alias === alias && binding.tool === tool.name)
    ),
    (tool) => input.store.createBinding({
      id: newClientToolBindingId(),
      tenantId: input.client.tenantId,
      clientId: input.client.id,
      alias,
      tool: ToolName.make(tool.name),
      connection: {
        owner: "org",
        integration: IntegrationSlug.make(tool.integration),
        name: ConnectionName.make(tool.connection)
      }
    }),
    { discard: true }
  )
})
