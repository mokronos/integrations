import type { IntegrationsApi } from "@mokronos/integrations"
import { Effect } from "effect"
import {
  ConnectionName,
  connectionRefKey,
  IntegrationSlug,
  type AccessProfile,
  type AccessProfileTool,
  type ApprovalPolicy,
  type ApprovalPolicyTool,
  type Client,
  type ConnectionRef,
  type PolicyDecision,
  ToolName
} from "./domain.ts"
import { type GatewayStore, GatewayStoreError } from "./store.ts"

interface ConfigurationCatalog {
  readonly tools: Pick<IntegrationsApi["tools"], "summaries">
}

const routeKey = (connection: ConnectionRef, tool: string): string =>
  `${connectionRefKey(connection)}\u0000${tool}`

const catalogTools = Effect.fn("Configurations.catalogTools")(function*(integrations: ConfigurationCatalog) {
  const summaries = yield* Effect.promise(() => integrations.tools.summaries())
  const tools = new Map<string, {
    readonly connection: ConnectionRef
    readonly tool: ToolName
    readonly decision: PolicyDecision
  }>()
  for (const summary of summaries) {
    if (summary.owner !== "org") continue
    const connection = {
      owner: "org",
      integration: IntegrationSlug.make(summary.integration),
      name: ConnectionName.make(summary.connection)
    } as const
    const key = routeKey(connection, summary.name)
    const existing = tools.get(key)
    tools.set(key, {
      connection,
      tool: ToolName.make(summary.name),
      decision: existing?.decision === "require_approval"
        || summary.defaultDecision === "require_approval"
        ? "require_approval"
        : "allow"
    })
  }
  return [...tools.values()]
})

export interface DefaultConfigurations {
  readonly accessProfile: AccessProfile | undefined
  readonly approvalPolicy: ApprovalPolicy | undefined
}

/** Adds newly catalogued tools to both tenant defaults without rewriting
 * operator choices already present in either resource. */
export const reconcileDefaults = Effect.fn("Grants.reconcileDefaults")(function*(input: {
  readonly store: GatewayStore
  readonly integrations: ConfigurationCatalog
  readonly tenantId: Client["tenantId"]
}): Effect.fn.Return<DefaultConfigurations, GatewayStoreError> {
  const [catalog, accessProfile, approvalPolicy] = yield* Effect.all([
    catalogTools(input.integrations),
    input.store.findDefaultAccessProfile(input.tenantId),
    input.store.findDefaultApprovalPolicy(input.tenantId)
  ])

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

  if (approvalPolicy !== undefined) {
    const existing = yield* input.store.listApprovalPolicyTools(approvalPolicy.id)
    const routes = new Set(existing.map((entry) => routeKey(entry.connection, entry.tool)))
    const added: ReadonlyArray<Omit<ApprovalPolicyTool, "approvalPolicyId">> = catalog
      .filter((entry) => !routes.has(routeKey(entry.connection, entry.tool)))
      .map(({ connection, tool, decision }) => ({ connection, tool, decision }))
    if (added.length > 0) {
      yield* input.store.replaceApprovalPolicyTools(approvalPolicy.id, [...existing, ...added])
    }
  }

  return { accessProfile, approvalPolicy }
})

/** Removes a vanished connection from every reusable configuration. */
export const forgetConnection = Effect.fn("Grants.forgetConnection")(function*(input: {
  readonly store: GatewayStore
  readonly tenantId: Client["tenantId"]
  readonly integration: string
  readonly connection: string
}): Effect.fn.Return<void, GatewayStoreError> {
  const names = (row: { readonly connection: ConnectionRef }): boolean =>
    row.connection.integration === input.integration && row.connection.name === input.connection
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
