import type { IntegrationHost } from "@mokronos/integrations"
import { IntegrationSlug, TenantId } from "./domain.ts"
import type { DriftEntry, ToolSnapshot } from "./domain.ts"
import { Effect, Schema } from "effect"
import type { GatewayStore, GatewayStoreError } from "./store.ts"

const schemaFingerprint = (snapshot: Pick<ToolSnapshot, "inputSchema" | "outputSchema">): string =>
  JSON.stringify([snapshot.inputSchema ?? null, snapshot.outputSchema ?? null])

export const diffSnapshots = (
  previous: ReadonlyArray<ToolSnapshot>,
  current: ReadonlyArray<ToolSnapshot>
): ReadonlyArray<DriftEntry> => {
  const key = (snapshot: ToolSnapshot): string =>
    `${snapshot.integration}\u0000${snapshot.connection}\u0000${snapshot.tool}`
  const before = new Map(previous.map((snapshot) => [key(snapshot), snapshot]))
  const after = new Map(current.map((snapshot) => [key(snapshot), snapshot]))
  const entries: Array<DriftEntry> = []

  for (const [identity, snapshot] of after) {
    const existing = before.get(identity)
    if (existing === undefined) {
      entries.push({
        kind: "added",
        integration: snapshot.integration,
        connection: snapshot.connection,
        tool: snapshot.tool
      })
      continue
    }
    if (schemaFingerprint(existing) !== schemaFingerprint(snapshot)) {
      entries.push({
        kind: "changed",
        integration: snapshot.integration,
        connection: snapshot.connection,
        tool: snapshot.tool
      })
    }
  }

  for (const [identity, snapshot] of before) {
    if (after.has(identity)) continue
    entries.push({
      kind: "removed",
      integration: snapshot.integration,
      connection: snapshot.connection,
      tool: snapshot.tool
    })
  }

  return entries
}

export interface ToolCatalogReader {
  readonly host: Pick<IntegrationHost["Service"], "listTools">
}

export type DriftReport = {
  readonly integration: string
  readonly entries: ReadonlyArray<DriftEntry>
  readonly checkedAt: Date
  readonly baseline: boolean
  readonly tools: number
}

export class DriftRefreshError extends Schema.TaggedError<DriftRefreshError>()(
  "DriftRefreshError",
  {
    integration: Schema.String,
    cause: Schema.Defect()
  }
) {}

export const refreshIntegrationSnapshot = Effect.fn("Drift.refreshIntegrationSnapshot")(
  function*(
    dependencies: {
      readonly store: GatewayStore
      readonly integrations: ToolCatalogReader
    },
    integration: string,
    tenantId: TenantId
  ): Effect.fn.Return<DriftReport, DriftRefreshError | GatewayStoreError> {
    const slug = IntegrationSlug.make(integration)
    const checkedAt = new Date()
    const tools = yield* dependencies.integrations.host.listTools({ integration: slug }).pipe(
      Effect.mapError((cause) => new DriftRefreshError({ integration, cause }))
    )
    const current: ReadonlyArray<ToolSnapshot> = tools.map((tool) => ({
      integration: slug,
      connection: tool.connection,
      tool: tool.name,
      inputSchema: tool.inputSchema ?? null,
      outputSchema: tool.outputSchema ?? null,
      syncedAt: checkedAt
    }))
    const previous = yield* dependencies.store.listToolSnapshots(tenantId, slug)
    const baseline = previous.length === 0
    const entries = baseline ? [] : diffSnapshots(previous, current)
    yield* dependencies.store.putToolSnapshots(tenantId, current)
    yield* dependencies.store.forgetToolSnapshots(
      tenantId,
      entries.filter((entry) => entry.kind === "removed").map((entry) => ({
        integration: slug,
        connection: entry.connection,
        tool: entry.tool
      }))
    )
    return { integration, entries, checkedAt, baseline, tools: current.length }
  }
)
