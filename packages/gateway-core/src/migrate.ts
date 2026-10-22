import type { Effect } from "effect"
import type { SqlError } from "effect/sql"
import type { SqlClient } from "effect/sql"
import { applyMigrations } from "@integragents/integrations"
import type { Migration, MigrationSet } from "@integragents/integrations"
import { gatewayMigrations } from "./store-migrations.gen.ts"

/** The gateway's own tables; stamped in `gateway_migration`. */
export const gatewayMigrationSet: MigrationSet = { ledger: "gateway_migration", migrations: gatewayMigrations }

export const applyGatewayMigrations = (
  sql: SqlClient.SqlClient
): Effect.Effect<ReadonlyArray<Migration>, SqlError.SqlError> => applyMigrations(sql, gatewayMigrationSet)
