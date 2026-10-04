import type { Integrations, StorageError } from "@integragents/host"
import { Effect } from "effect"
import {
  connectionRefKey,
  sameConnectionRef,
  type ConnectionName,
  type ConnectionRef,
  type IntegrationSlug,
  type ProfileToolInput,
  type TenantId
} from "./domain.ts"
import type { GatewayStore, GatewayStoreError } from "./store.ts"

type ProfileCatalog = Pick<Integrations["Service"], "toolSummaries">

const routeKey = (connection: ConnectionRef, tool: string): string =>
  `${connectionRefKey(connection)}\u0000${tool}`

/** Every org tool the gateway can reach, decided the way its source suggests: reads run, the rest ask. */
export const catalogProfileTools = Effect.fn("Profiles.catalogTools")(function*(
  integrations: ProfileCatalog,
  scope: { readonly integration?: IntegrationSlug; readonly connection?: ConnectionName } = {}
) {
  const summaries = yield* integrations.toolSummaries(scope)
  const tools = new Map<string, ProfileToolInput>()
  for (const summary of summaries) {
    if (summary.owner !== "org") continue
    const connection = { owner: "org", integration: summary.integration, name: summary.connection } as const
    const key = routeKey(connection, summary.name)
    tools.set(key, {
      connection,
      tool: summary.name,
      decision: tools.get(key)?.decision === "require_approval" || summary.defaultDecision === "require_approval"
        ? "require_approval"
        : "allow"
    })
  }
  return [...tools.values()]
})

const rewriteProfiles = Effect.fn("Profiles.rewrite")(function*(
  store: GatewayStore,
  tenantId: TenantId,
  rewrite: (
    tools: ReadonlyArray<ProfileToolInput>,
    profile: { readonly includeNewTools: boolean }
  ) => ReadonlyArray<ProfileToolInput>
): Effect.fn.Return<void, GatewayStoreError> {
  const profiles = yield* store.listProfiles(tenantId)
  yield* Effect.forEach(profiles, (profile) => Effect.gen(function*() {
    if (profile.revokedAt !== null) return
    const tools = yield* store.listProfileTools(profile.id)
    const next = rewrite(tools, profile)
    const unchanged = next.length === tools.length
      && next.every((tool, index) => {
        const current = tools[index]
        return current !== undefined && routeKey(current.connection, current.tool) === routeKey(tool.connection, tool.tool)
          && current.decision === tool.decision
      })
    if (!unchanged) yield* store.replaceProfileTools(profile.id, next)
  }), { discard: true })
})

/** Drops tools on org connections the integration host no longer holds. */
export const pruneProfileTools = Effect.fn("Profiles.prune")(function*(input: {
  readonly store: GatewayStore
  readonly integrations: ProfileCatalog
  readonly tenantId: TenantId
}): Effect.fn.Return<void, GatewayStoreError | StorageError> {
  const catalog = yield* catalogProfileTools(input.integrations)
  const live = new Set(catalog.map((entry) => connectionRefKey(entry.connection)))
  yield* rewriteProfiles(input.store, input.tenantId, (tools) =>
    tools.filter((tool) => tool.connection.owner !== "org" || live.has(connectionRefKey(tool.connection))))
})

/**
 * A connection that just came up joins every profile that asked for new
 * tools. Tools a vendor adds later do not: those wait for a human.
 */
export const includeConnectionTools = Effect.fn("Profiles.includeConnection")(function*(input: {
  readonly store: GatewayStore
  readonly integrations: ProfileCatalog
  readonly tenantId: TenantId
  readonly integration: IntegrationSlug
  readonly connection: ConnectionName
}): Effect.fn.Return<void, GatewayStoreError | StorageError> {
  const added = yield* catalogProfileTools(input.integrations, {
    integration: input.integration,
    connection: input.connection
  })
  yield* rewriteProfiles(input.store, input.tenantId, (tools, profile) => {
    if (!profile.includeNewTools) return tools
    const held = new Set(tools.map((tool) => routeKey(tool.connection, tool.tool)))
    return [...tools, ...added.filter((tool) => !held.has(routeKey(tool.connection, tool.tool)))]
  })
})

/** Drops the tools that named exactly this connection. A user's connection leaving keeps the template. */
export const forgetConnection = Effect.fn("Profiles.forgetConnection")(function*(input: {
  readonly store: GatewayStore
  readonly tenantId: TenantId
  readonly connection: ConnectionRef
}): Effect.fn.Return<void, GatewayStoreError> {
  yield* rewriteProfiles(input.store, input.tenantId, (tools) =>
    tools.filter((tool) => !sameConnectionRef(tool.connection, input.connection)))
})
