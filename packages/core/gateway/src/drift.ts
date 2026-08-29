import type { IntegrationsApi } from "@mokronos/integrations"
import { ConnectionName, IntegrationSlug, TenantId, ToolName } from "./domain.ts"
import type { DriftEntry, ToolSnapshot } from "./domain.ts"
import { Effect, Schema } from "effect"
import type { GatewayStore, GatewayStoreError } from "./store.ts"

/** Pure discovery means tool names and shapes belong to vendors. A rename or a
 * reshaped schema is therefore a normal event, not a bug — but it is one that
 * silently breaks grants and workflows if nobody is told.
 *
 * The failure direction is already safe: a grant that no longer matches denies
 * rather than allows. What is missing without this is the *signal*, so a
 * workflow does not die at 3am with "tool not found" and no explanation. */
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
      // Newly exposed tools are reported too: under explicit grants they are
      // unreachable until someone delegates them, which makes them easy to miss.
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

/** The single host capability drift detection needs: re-reading what a
 *  vendor exposes right now. Naming the narrow contract here means a stand-in
 *  satisfies it honestly, instead of impersonating the whole host surface
 *  and casting the gap away. */
export interface ToolCatalogReader {
  readonly tools: Pick<IntegrationsApi["tools"], "list">
}

export type DriftReport = {
  readonly integration: string
  readonly entries: ReadonlyArray<DriftEntry>
  readonly checkedAt: Date
  /** True when there was nothing to compare against — the first sync records
   *  the shape rather than discovering that all of it is new. Reporting fifty
   *  "added" entries for an integration nobody has synced yet is noise that
   *  buries the one real change in the next run. */
  readonly baseline: boolean
  /** How many tools the integration exposes right now. */
  readonly tools: number
}

export class DriftRefreshError extends Schema.TaggedError<DriftRefreshError>()(
  "DriftRefreshError",
  {
    integration: Schema.String,
    cause: Schema.Defect()
  }
) {}

/** Re-reads an integration's tools, reports what moved since the last sync, and
 *  records the new shape as the baseline. Snapshots are per tenant: two tenants
 *  connecting to the same vendor track their drift independently. */
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
    const tools = yield* Effect.tryPromise({
      try: () => dependencies.integrations.tools.list({ integration }),
      catch: (cause) => new DriftRefreshError({ integration, cause })
    })
    const current: ReadonlyArray<ToolSnapshot> = tools.map((tool) => ({
      integration: slug,
      connection: ConnectionName.make(tool.connection),
      tool: ToolName.make(tool.name),
      inputSchema: tool.inputSchema ?? null,
      outputSchema: tool.outputSchema ?? null,
      syncedAt: checkedAt
    }))
    const previous = yield* dependencies.store.listToolSnapshots(tenantId, slug)
    const baseline = previous.length === 0
    const entries = baseline ? [] : diffSnapshots(previous, current)
    yield* dependencies.store.putToolSnapshots(tenantId, current)
    // Removed tools keep their old snapshot row, so the next refresh does not
    // report the same removal forever.
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
