import type { Integrations, StorageError } from "@mokronos/integrations-host"
import { Effect } from "effect"
import {
  connectionRefKey,
  sameConnectionRef,
  type AccessProfile,
  type AccessProfileTool,
  type ApprovalPolicy,
  type Client,
  type ConnectionRef,
  type PolicyDecision,
  ToolName
} from "./domain.ts"
import { type ApprovalPolicyToolInput, type GatewayStore, GatewayStoreError } from "./store.ts"

type ConfigurationCatalog = Pick<Integrations["Service"], "toolSummaries">

const routeKey = (connection: ConnectionRef, tool: string): string =>
  `${connectionRefKey(connection)}\u0000${tool}`

export const catalogConfigurationTools = Effect.fn("Configurations.catalogTools")(function*(integrations: ConfigurationCatalog) {
  const summaries = yield* integrations.toolSummaries()
  const tools = new Map<string, {
    readonly connection: ConnectionRef
    readonly tool: ToolName
    readonly decision: PolicyDecision
  }>()
  for (const summary of summaries) {
    if (summary.owner !== "org") continue
    const connection = {
      owner: "org",
      integration: summary.integration,
      name: summary.connection
    } as const
    const key = routeKey(connection, summary.name)
    const existing = tools.get(key)
    tools.set(key, {
      connection,
      tool: summary.name,
      decision: existing?.decision === "require_approval"
        || summary.defaultDecision === "require_approval"
        ? "require_approval"
        : "allow"
    })
  }
  return [...tools.values()]
})

export const completeApprovalPolicyTools = (
  catalog: ReadonlyArray<ApprovalPolicyToolInput>,
  configured: ReadonlyArray<ApprovalPolicyToolInput> = []
): ReadonlyArray<ApprovalPolicyToolInput> => {
  const completed = new Map(catalog.map((entry) => [routeKey(entry.connection, entry.tool), entry]))
  const overrides = new Map<string, ApprovalPolicyToolInput>()
  for (const entry of configured) {
    const key = routeKey(entry.connection, entry.tool)
    const existing = overrides.get(key)
    overrides.set(key, {
      connection: entry.connection,
      tool: entry.tool,
      decision: existing?.decision === "require_approval" || entry.decision === "require_approval"
        ? "require_approval"
        : "allow"
    })
  }
  for (const [key, entry] of overrides) completed.set(key, entry)
  return [...completed.values()]
}

export interface DefaultConfigurations {
  readonly accessProfile: AccessProfile | undefined
  readonly approvalPolicy: ApprovalPolicy | undefined
}

export const reconcileConfigurations = Effect.fn("Configurations.reconcile")(function*(input: {
  readonly store: GatewayStore
  readonly integrations: ConfigurationCatalog
  readonly tenantId: Client["tenantId"]
}): Effect.fn.Return<DefaultConfigurations, GatewayStoreError | StorageError> {
  const [catalog, accessProfile, accessProfiles, approvalPolicies] = yield* Effect.all([
    catalogConfigurationTools(input.integrations),
    input.store.findDefaultAccessProfile(input.tenantId),
    input.store.listAccessProfiles(input.tenantId),
    input.store.listApprovalPolicies(input.tenantId)
  ])
  const approvalPolicy = approvalPolicies.find((policy) => policy.isDefault)

  const liveConnections = new Set(catalog.map((entry) => connectionRefKey(entry.connection)))
  const gone = (row: { readonly connection: ConnectionRef }): boolean =>
    row.connection.owner === "org" && !liveConnections.has(connectionRefKey(row.connection))
  yield* Effect.forEach(accessProfiles, (profile) => Effect.gen(function*() {
    const tools = yield* input.store.listAccessProfileTools(profile.id)
    const remaining = tools.filter((tool) => !gone(tool))
    if (remaining.length !== tools.length) yield* input.store.replaceAccessProfileTools(profile.id, remaining)
  }), { discard: true })
  yield* Effect.forEach(approvalPolicies, (policy) => Effect.gen(function*() {
    const tools = yield* input.store.listApprovalPolicyTools(policy.id)
    const remaining = tools.filter((tool) => !gone(tool))
    if (remaining.length !== tools.length) yield* input.store.replaceApprovalPolicyTools(policy.id, remaining)
  }), { discard: true })

  if (accessProfile !== undefined) {
    const existing = yield* input.store.listAccessProfileTools(accessProfile.id)
    const routes = new Set(existing.map((entry) => routeKey(entry.connection, entry.tool)))
    const added: ReadonlyArray<Omit<AccessProfileTool, "accessProfileId">> = catalog
      .filter((entry) => !routes.has(routeKey(entry.connection, entry.tool)))
      .map(({ connection, tool }) => ({ connection, tool }))
    if (added.length > 0) {
      yield* input.store.replaceAccessProfileTools(accessProfile.id, [...existing, ...added])
    }
  }

  // Every granted route needs a decision, including delegation templates an
  // administrator granted by hand. Those the catalog does not know default to
  // asking a human, the same way unclassified tools do.
  const granted = (yield* Effect.forEach(
    accessProfiles,
    (profile) => input.store.listAccessProfileTools(profile.id)
  )).flat()
  yield* Effect.forEach(approvalPolicies, (policy) => Effect.gen(function*() {
    const existing = yield* input.store.listApprovalPolicyTools(policy.id)
    const completed = completeApprovalPolicyTools(catalog, existing)
    const decided = new Set(completed.map((entry) => routeKey(entry.connection, entry.tool)))
    const undecided = granted
      .filter((entry) => !decided.has(routeKey(entry.connection, entry.tool)))
      .map((entry): ApprovalPolicyToolInput => ({ connection: entry.connection, tool: entry.tool, decision: "require_approval" }))
    const withGrants = [...completed, ...undecided.filter((entry, index) =>
      undecided.findIndex((other) => routeKey(other.connection, other.tool) === routeKey(entry.connection, entry.tool)) === index)]
    if (withGrants.length > existing.length) {
      yield* input.store.replaceApprovalPolicyTools(policy.id, withGrants)
    }
  }), { discard: true })

  return { accessProfile, approvalPolicy }
})

/** Drops the grants that named exactly this connection. A user's connection leaving keeps the template. */
export const forgetConnection = Effect.fn("Grants.forgetConnection")(function*(input: {
  readonly store: GatewayStore
  readonly tenantId: Client["tenantId"]
  readonly connection: ConnectionRef
}): Effect.fn.Return<void, GatewayStoreError> {
  const names = (row: { readonly connection: ConnectionRef }): boolean =>
    sameConnectionRef(row.connection, input.connection)
  const [accessProfiles, approvalPolicies] = yield* Effect.all([
    input.store.listAccessProfiles(input.tenantId),
    input.store.listApprovalPolicies(input.tenantId)
  ])
  yield* Effect.forEach(accessProfiles, (profile) => Effect.gen(function*() {
    const tools = yield* input.store.listAccessProfileTools(profile.id)
    const remaining = tools.filter((tool) => !names(tool))
    if (remaining.length !== tools.length) {
      yield* input.store.replaceAccessProfileTools(profile.id, remaining)
    }
  }), { discard: true })
  yield* Effect.forEach(approvalPolicies, (policy) => Effect.gen(function*() {
    const tools = yield* input.store.listApprovalPolicyTools(policy.id)
    const remaining = tools.filter((tool) => !names(tool))
    if (remaining.length !== tools.length) {
      yield* input.store.replaceApprovalPolicyTools(policy.id, remaining)
    }
  }), { discard: true })
})
