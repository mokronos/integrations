import type { Effect } from "effect"
import type { SqlError } from "effect/unstable/sql"
import type { SqlClient } from "effect/unstable/sql"
import { applyMigrations } from "@integrations/integrations"
import type { Migration, MigrationSet } from "@integrations/integrations"
import { gatewayMigrations } from "./store-migrations.gen.ts"

/** The gateway's own tables; stamped in `gateway_migration`. */
export const gatewayMigrationSet: MigrationSet = { ledger: "gateway_migration", migrations: gatewayMigrations }

export const applyGatewayMigrations = (
  sql: SqlClient.SqlClient
): Effect.Effect<ReadonlyArray<Migration>, SqlError.SqlError> => applyMigrations(sql, gatewayMigrationSet)
