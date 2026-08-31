import type { IntegrationsApi } from "@mokronos/integrations"
import { Effect } from "effect"
import {
  Alias,
  type Client,
  ConnectionName,
  type ConnectionGrant,
  type ConnectionRef,
  connectionRefKey,
  IntegrationSlug,
  type Policy,
  type PolicyDecision,
  type PolicyTool,
  sameConnectionRef,
  ToolName
} from "./domain.ts"
import { newConnectionGrantId, newPolicyId } from "./keys.ts"
import { type GatewayStore, GatewayStoreError } from "./store.ts"

interface PolicyCatalog {
  readonly tools: Pick<IntegrationsApi["tools"], "summaries">
  readonly connections: Pick<IntegrationsApi["connections"], "list">
}

/** An `Alias` is stricter than the slugs it is built from: lowercase letters,
 * digits and dashes, and it must begin with a letter. `1password` and
 * `google_sheets` are valid integration slugs but not valid aliases, so both
 * are folded here rather than at the call site. */
const aliasFor = (value: string): Alias => {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
  return Alias.make(/^[a-z]/.test(sanitized) ? sanitized : `c-${sanitized}`)
}

/** The name one client will call one connection by, chosen once at grant time.
 *
 * First come, first served. The first Linear connection a client is granted
 * takes the plain `linear`; a second one granted later finds it taken and
 * becomes `linear-personal`. The incumbent is never renamed — that is the
 * whole reason this is allocated and stored rather than derived from the set
 * of connections a client currently holds. */
export const allocateAlias = (
  connection: ConnectionRef,
  taken: ReadonlySet<string>
): Alias => {
  const plain = aliasFor(connection.integration)
  if (!taken.has(plain)) return plain
  const qualified = aliasFor(`${connection.integration}-${connection.name}`)
  if (!taken.has(qualified)) return qualified
  for (let suffix = 2; ; suffix += 1) {
    const candidate = aliasFor(`${connection.integration}-${connection.name}-${suffix}`)
    if (!taken.has(candidate)) return candidate
  }
}

/** Every org-tier tool the catalog reports for one connection.
 *
 * Only org-tier: a `ToolSummary` names its owner tier but not the subject
 * behind a user-tier connection, so there is no way to tell one human's Gmail
 * tools from another's here. Seeding rules for those would be guesswork. */
const catalogTools = Effect.fn("Grants.catalogTools")(function*(input: {
  readonly integrations: PolicyCatalog
  readonly connection: ConnectionRef
}) {
  if (input.connection.owner !== "org") return []
  const summaries = yield* Effect.promise(() =>
    input.integrations.tools.summaries({
      integration: input.connection.integration,
      connection: input.connection.name,
      owner: "org"
    }))
  const byName = new Map<string, PolicyDecision>()
  for (const summary of summaries) {
    if (summary.owner !== "org") continue
    if (summary.integration !== input.connection.integration) continue
    if (summary.connection !== input.connection.name) continue
    // A duplicate name within one connection keeps the cautious default.
    const existing = byName.get(summary.name)
    byName.set(
      summary.name,
      existing === "require_approval" || summary.defaultDecision === "require_approval"
        ? "require_approval"
        : "allow"
    )
  }
  return [...byName].map(([name, decision]) => ({
    tool: ToolName.make(name),
    decision
  }))
})

const ruleInput = (rule: PolicyTool) => ({
  connection: rule.connection,
  tool: rule.tool,
  enabled: rule.enabled,
  decision: rule.decision
})

/** Keeps the tenant's default policy abreast of the catalog.
 *
 * The default policy is the one that means "everything this tenant has
 * connected", so a newly connected credential joins it automatically. That is
 * safe now in a way it was not before: a rule authorizes nothing on its own,
 * so absorbing a connection here hands it to no client. A client reaches it
 * only once it holds a grant.
 *
 * Custom policies are deliberately left alone. Existing enabled states and
 * decisions are never rewritten. */
export const reconcileDefaultPolicy = Effect.fn("Grants.reconcileDefaultPolicy")(
  function*(input: {
    readonly store: GatewayStore
    readonly integrations: PolicyCatalog
    readonly tenantId: Client["tenantId"]
  }): Effect.fn.Return<Policy | undefined, GatewayStoreError> {
    const policy = yield* input.store.findDefaultPolicy(input.tenantId)
    if (policy === undefined) return undefined

    const [summaries, existing] = yield* Effect.all([
      Effect.promise(() => input.integrations.tools.summaries()),
      input.store.listPolicyTools(policy.id)
    ])
    const rules = new Map(existing.map((rule) => [
      `${connectionRefKey(rule.connection)} ${rule.tool}`,
      ruleInput(rule)
    ]))
    let added = 0
    for (const summary of summaries) {
      if (summary.owner !== "org") continue
      const connection = {
        owner: "org",
        integration: IntegrationSlug.make(summary.integration),
        name: ConnectionName.make(summary.connection)
      } as const
      const key = `${connectionRefKey(connection)} ${summary.name}`
      if (rules.has(key)) continue
      rules.set(key, {
        connection,
        tool: ToolName.make(summary.name),
        enabled: true,
        decision: summary.defaultDecision
      })
      added += 1
    }
    if (added === 0) return policy
    yield* input.store.replacePolicyTools(policy.id, [...rules.values()])
    return policy
  }
)

/** What granting a connection did to the client's policy, so the caller can
 * tell an operator what happened rather than leaving a fork to be discovered
 * later in the policy list. */
export type PolicySeeding =
  /** The policy already governed this connection; nothing was written. */
  | { readonly kind: "already-governed"; readonly policy: Policy }
  /** Rules were added to the client's own policy. Either it is the tenant
   *  default, or no other live client is assigned to it, so nobody else is
   *  affected. */
  | { readonly kind: "seeded-in-place"; readonly policy: Policy }
  /** The policy was shared, so it was copied. The client now uses the copy and
   *  the original is untouched. */
  | { readonly kind: "forked"; readonly policy: Policy; readonly forkedFrom: Policy }
  /** The catalog reports no tools to write rules for — a user-tier connection,
   *  or one whose catalog read failed. The grant still stands. */
  | { readonly kind: "no-tools"; readonly policy: Policy }
  /** The client's assigned policy could not be read. */
  | { readonly kind: "no-policy" }

/** A fork is named after the client that caused it, and policy names are unique
 * within a tenant, so a collision gets a counter rather than failing the grant. */
const forkName = (
  policy: Policy,
  client: Client,
  taken: ReadonlySet<string>
): string => {
  const base = `${policy.name} (${client.name})`
  if (!taken.has(base)) return base
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base} ${suffix}`
    if (!taken.has(candidate)) return candidate
  }
}

/** Makes the client's policy govern one connection, copying the policy first if
 * other clients share it.
 *
 * Writing rules straight into a shared policy would widen what every other
 * client on it could reach the moment they were granted the same connection,
 * which is the class of surprise this whole design removes. Copying keeps the
 * blast radius at one client.
 *
 * The trade is real and deliberate: a fork stops tracking later edits to the
 * policy it came from. So it happens only when the policy is genuinely shared —
 * a policy with one client, or the tenant default, is edited in place, because
 * there is nobody to protect. */
const ensurePolicyGoverns = Effect.fn("Grants.ensurePolicyGoverns")(function*(input: {
  readonly store: GatewayStore
  readonly integrations: PolicyCatalog
  readonly client: Client
  readonly connection: ConnectionRef
}): Effect.fn.Return<PolicySeeding, GatewayStoreError> {
  const policy = yield* input.store.findPolicy(input.client.tenantId, input.client.policyId)
  if (policy === undefined) return { kind: "no-policy" }

  const rules = yield* input.store.listPolicyTools(policy.id)
  if (rules.some((rule) => sameConnectionRef(rule.connection, input.connection))) {
    return { kind: "already-governed", policy }
  }

  const tools = yield* catalogTools({
    integrations: input.integrations,
    connection: input.connection
  })
  if (tools.length === 0) return { kind: "no-tools", policy }

  const seeded = [
    ...rules.map(ruleInput),
    ...tools.map((tool) => ({
      connection: input.connection,
      tool: tool.tool,
      enabled: true,
      decision: tool.decision
    }))
  ]

  const [clients, policies] = yield* Effect.all([
    input.store.listClients(input.client.tenantId),
    input.store.listPolicies(input.client.tenantId)
  ])
  const sharers = clients.filter((candidate) =>
    candidate.policyId === policy.id && candidate.revokedAt === null)
  if (policy.isDefault || sharers.length <= 1) {
    yield* input.store.replacePolicyTools(policy.id, seeded)
    return { kind: "seeded-in-place", policy }
  }

  const fork = yield* input.store.createPolicy({
    tenantId: input.client.tenantId,
    id: newPolicyId(),
    name: forkName(policy, input.client, new Set(policies.map((entry) => entry.name))),
    forkedFrom: policy.id
  })
  yield* input.store.replacePolicyTools(fork.id, seeded)
  yield* input.store.assignPolicy(input.client.tenantId, input.client.id, fork.id)
  return { kind: "forked", policy: fork, forkedFrom: policy }
})

export interface GrantOutcome {
  readonly grant: ConnectionGrant
  /** True when the client already held this connection and nothing was written.
   *  Granting twice is not an error — an agent re-running `i connect` should
   *  meet the grant it already has, under the alias it already knows. */
  readonly existing: boolean
  readonly seeding: PolicySeeding
}

/** Gives one client reach to one connection.
 *
 * Two things happen, in this order and never half of one: the client gets a
 * grant with a stable alias, and its policy is made to govern that connection.
 * Neither implies the other elsewhere — connecting a credential grants nothing,
 * and a policy rule reaches nothing without a grant. */
export const grantConnection = Effect.fn("Grants.grantConnection")(function*(input: {
  readonly store: GatewayStore
  readonly integrations: PolicyCatalog
  readonly client: Client
  readonly connection: ConnectionRef
}): Effect.fn.Return<GrantOutcome, GatewayStoreError> {
  const held = yield* input.store.listGrants(input.client.id)
  const already = held.find((grant) => sameConnectionRef(grant.connection, input.connection))
  const seeding = yield* ensurePolicyGoverns({
    store: input.store,
    integrations: input.integrations,
    client: input.client,
    connection: input.connection
  })
  if (already !== undefined) return { grant: already, existing: true, seeding }

  const grant = yield* input.store.createGrant({
    tenantId: input.client.tenantId,
    id: newConnectionGrantId(),
    clientId: input.client.id,
    connection: input.connection,
    alias: allocateAlias(input.connection, new Set(held.map((entry) => entry.alias)))
  })
  return { grant, existing: false, seeding }
})

/** Grants a client every org-tier connection the tenant has, skipping the ones
 * it already holds.
 *
 * This is the "trusted operator agent" shape — the local CLI client, which is
 * the human's own hands — not something a delegated client gets. Aliases are
 * allocated one connection at a time against what the client already holds, so
 * running this again after a new credential appears leaves every existing alias
 * exactly as it was. */
export const grantCatalogConnections = Effect.fn("Grants.grantCatalogConnections")(
  function*(input: {
    readonly store: GatewayStore
    readonly integrations: PolicyCatalog
    readonly client: Client
  }): Effect.fn.Return<ReadonlyArray<GrantOutcome>, GatewayStoreError> {
    const connections = yield* Effect.promise(() => input.integrations.connections.list())
    const outcomes: Array<GrantOutcome> = []
    for (const connection of connections) {
      if (connection.owner !== "org") continue
      outcomes.push(yield* grantConnection({
        store: input.store,
        integrations: input.integrations,
        client: input.client,
        connection: {
          owner: "org",
          integration: IntegrationSlug.make(connection.integration),
          name: ConnectionName.make(connection.name)
        }
      }))
    }
    return outcomes
  }
)

/** Withdraws every client's reach to a connection that no longer exists.
 *
 * Policy rules that name it go too: a rule that reads as live in the dashboard
 * while resolving to nothing at call time is worse than no rule. */
export const forgetConnection = Effect.fn("Grants.forgetConnection")(function*(input: {
  readonly store: GatewayStore
  readonly tenantId: Client["tenantId"]
  readonly integration: string
  readonly connection: string
}): Effect.fn.Return<void, GatewayStoreError> {
  const names = (row: { readonly connection: ConnectionRef }): boolean =>
    row.connection.integration === input.integration
    && row.connection.name === input.connection

  const policies = yield* input.store.listPolicies(input.tenantId)
  yield* Effect.forEach(policies, (policy) =>
    Effect.gen(function*() {
      const rules = yield* input.store.listPolicyTools(policy.id)
      const remaining = rules.filter((rule) => !names(rule))
      if (remaining.length === rules.length) return
      yield* input.store.replacePolicyTools(policy.id, remaining.map(ruleInput))
    }), { discard: true })

  const clients = yield* input.store.listClients(input.tenantId)
  yield* Effect.forEach(clients, (client) =>
    Effect.gen(function*() {
      const grants = yield* input.store.listGrants(client.id)
      yield* Effect.forEach(
        grants.filter(names),
        (grant) => input.store.revokeGrant(input.tenantId, grant.id),
        { discard: true }
      )
    }), { discard: true })
})
