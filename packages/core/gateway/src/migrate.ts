import { Effect, Schema } from "effect"
import type { SqlError } from "effect/unstable/sql"
import { SqlClient } from "effect/unstable/sql"
import { type GatewayMigration, gatewayMigrations } from "./store-migrations.gen.ts"

const ledgerDdl = `CREATE TABLE IF NOT EXISTS gateway_migration (
   id INTEGER PRIMARY KEY,
   name TEXT NOT NULL,
   applied_at INTEGER NOT NULL
 )`

const stampSql = "INSERT INTO gateway_migration (id, name, applied_at) VALUES (?, ?, ?)"

const AppliedRow = Schema.Struct({
  id: Schema.Int,
  name: Schema.String
})

const decodeApplied = Schema.decodeUnknownSync(Schema.Array(AppliedRow))

const readApplied = Effect.fn("Migrations.readApplied")(function*(
  sql: SqlClient.SqlClient
) {
  const rows = yield* sql.unsafe<{ id: number; name: string }>(
    "SELECT id, name FROM gateway_migration ORDER BY id"
  )
  return new Map(
    decodeApplied(rows.map((row) => ({ id: row.id, name: row.name })))
      .map((row) => [row.id, row.name] as const)
  )
})

/**
 * Refuses to touch a database whose ledger this build cannot account for.
 * Either it was migrated by a newer gateway, or an applied migration was
 * rewritten under us; both mean the safe move is to stop rather than guess.
 */
const assertLedgerIsKnown = (applied: Map<number, string>): void => {
  const known = new Map(gatewayMigrations.map((migration) => [migration.id, migration.name]))
  for (const [id, name] of applied) {
    const expected = known.get(id)
    if (expected === undefined) {
      throw new Error(
        `The database has applied migration ${id} (${name}), which this build does not carry. ` +
          `It was migrated by a newer gateway; run that one instead.`
      )
    }
    if (expected !== name) {
      throw new Error(
        `The database applied migration ${id} as "${name}" but this build calls it "${expected}". ` +
          `An applied migration was renamed or rewritten; restore its name.`
      )
    }
  }
}

/**
 * Brings the database up to the shape this build declares.
 *
 * Effect's own Migrator does not fit here: it treats the highest applied id as
 * the watermark and skips anything at or below it, so our baseline at id 0
 * would never run on a fresh database, and it has no answer for a ledger
 * carrying migrations this build does not know about.
 */
export const applyGatewayMigrations = Effect.fn("Migrations.apply")(function*(
  sql: SqlClient.SqlClient
): Effect.fn.Return<ReadonlyArray<GatewayMigration>, SqlError.SqlError> {
  yield* sql.unsafe(ledgerDdl)
  const applied = yield* readApplied(sql)
  assertLedgerIsKnown(applied)

  const pending = gatewayMigrations
    .filter((migration) => !applied.has(migration.id))
    .toSorted((left, right) => left.id - right.id)

  const at = Date.now()
  for (const migration of pending) {
    yield* sql.withTransaction(Effect.gen(function*() {
      for (const statement of migration.statements) {
        yield* sql.unsafe(statement)
      }
      yield* sql.unsafe(stampSql, [migration.id, migration.name, at])
    }))
  }
  return pending
})
