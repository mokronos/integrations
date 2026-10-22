import { Context, Effect, Layer, Schema } from "effect"
import { ConnectionName, IntegrationSlug, ToolName } from "../domain.ts"
import type { TenantId, ToolSnapshot } from "../domain.ts"
import { millis, Millis, NullableJsonText } from "./columns.ts"
import { operation, StoreSql } from "./sql.ts"
import type { GatewayStoreError } from "./sql.ts"

/** The schemas each tool had when the gateway last looked, so drift shows what changed since. */
export interface ToolSnapshotStore {
  putToolSnapshots(tenantId: TenantId, snapshots: ReadonlyArray<ToolSnapshot>): Effect.Effect<void, GatewayStoreError>
  listToolSnapshots(
    tenantId: TenantId,
    integration: IntegrationSlug
  ): Effect.Effect<ReadonlyArray<ToolSnapshot>, GatewayStoreError>
  forgetToolSnapshots(
    tenantId: TenantId,
    keys: ReadonlyArray<{
      readonly integration: IntegrationSlug
      readonly connection: ConnectionName
      readonly tool: ToolName
    }>
  ): Effect.Effect<void, GatewayStoreError>
}

const SnapshotRow = Schema.Struct({
  integration: IntegrationSlug,
  connection: ConnectionName,
  tool: ToolName,
  inputSchema: NullableJsonText,
  outputSchema: NullableJsonText,
  syncedAt: Millis
}).pipe(
  Schema.encodeKeys({
    connection: "connection_name",
    inputSchema: "input_schema",
    outputSchema: "output_schema",
    syncedAt: "synced_at"
  })
)

const jsonColumn = (value: typeof Schema.Json.Type | null): string | null =>
  value === null ? null : JSON.stringify(value)

export class ToolSnapshotStoreService extends Context.Service<ToolSnapshotStoreService, ToolSnapshotStore>()(
  "@integragents/gateway-core/ToolSnapshotStore"
) {
  static readonly layer = Layer.effect(
    ToolSnapshotStoreService,
    Effect.map(StoreSql, (db): ToolSnapshotStore => ({
      putToolSnapshots: (tenantId, snapshots) =>
        operation(
          "putToolSnapshots",
          Effect.forEach(
            snapshots,
            (snapshot) =>
              db.run(
                `INSERT INTO gateway_tool_snapshot
               (tenant_id, integration, connection_name, tool, input_schema, output_schema, synced_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (tenant_id, integration, connection_name, tool) DO UPDATE SET
               input_schema = excluded.input_schema,
               output_schema = excluded.output_schema,
               synced_at = excluded.synced_at`,
                [
                  tenantId,
                  snapshot.integration,
                  snapshot.connection,
                  snapshot.tool,
                  jsonColumn(snapshot.inputSchema),
                  jsonColumn(snapshot.outputSchema),
                  millis(snapshot.syncedAt)
                ]
              ),
            { discard: true }
          )
        ),

      listToolSnapshots: (tenantId, integration) =>
        operation(
          "listToolSnapshots",
          db.all(
            SnapshotRow,
            "SELECT * FROM gateway_tool_snapshot WHERE tenant_id = ? AND integration = ? ORDER BY connection_name, tool",
            [tenantId, integration]
          )
        ),

      forgetToolSnapshots: (tenantId, keys) =>
        operation(
          "forgetToolSnapshots",
          Effect.forEach(
            keys,
            (key) =>
              db.run(
                "DELETE FROM gateway_tool_snapshot WHERE tenant_id = ? AND integration = ? AND connection_name = ? AND tool = ?",
                [tenantId, key.integration, key.connection, key.tool]
              ),
            { discard: true }
          )
        )
    }))
  )
}
