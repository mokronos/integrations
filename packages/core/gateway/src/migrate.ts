import type { Client as LibsqlClient, InStatement } from "@libsql/client"
import { Schema } from "effect"
import { type GatewayMigration, gatewayMigrations } from "./store-migrations.gen.ts"

// The gateway's schema is declared once, in db/schema.ts, and the SQL that
// carries a database from one declaration to the next is generated from it
// (`bun run db:generate`) rather than written by hand. This module is the other
// half: it applies the generated statements that a given database has not seen
// yet, and records which ones those were.
//
// It speaks the same libsql-shaped client the store queries through, so a
// Cloudflare D1 binding runs the same migrations as a local file, in the same
// order, with no drizzle in the bundle.

/** Names the migrations a database has already seen. `id` is the journal index
 *  drizzle-kit assigns, so it is stable for the life of the migration. */
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

/** What the database says it has already run, keyed by journal index. */
const readApplied = async (database: LibsqlClient): Promise<Map<number, string>> => {
  const result = await database.execute("SELECT id, name FROM gateway_migration ORDER BY id")
  const rows = decodeApplied(
    result.rows.map((row) => ({ id: row["id"], name: row["name"] }))
  )
  return new Map(rows.map((row) => [row.id, row.name]))
}

/** A database that has run something this build does not know about, or knows
 *  under a different name, is not a database this build can migrate: the
 *  generated SQL describes a path from the shape the journal records, and here
 *  the two disagree about what that shape is.
 *
 *  In practice this is a downgrade (an older gateway opening a newer database)
 *  or a migration that was renamed or rewritten after it had been applied
 *  somewhere. Both are worth stopping for, rather than migrating onto a shape
 *  nobody has described. */
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

const toStatements = (migration: GatewayMigration, at: number): Array<InStatement> => [
  ...migration.statements.map((sql) => ({ sql, args: [] })),
  { sql: stampSql, args: [migration.id, migration.name, at] }
]

/**
 * Brings a database up to the shape `db/schema.ts` declares, and returns the
 * migrations that had to run to get there. Applying an up-to-date database is a
 * single query and no writes.
 *
 * Each migration is applied together with its own stamp in one write batch, so
 * a half-applied migration cannot be recorded as complete — a failed run leaves
 * the database on the last shape it fully reached, and the next boot retries
 * from there.
 */
export const applyGatewayMigrations = async (
  database: LibsqlClient
): Promise<ReadonlyArray<GatewayMigration>> => {
  await database.execute(ledgerDdl)
  const applied = await readApplied(database)
  assertLedgerIsKnown(applied)

  const pending = gatewayMigrations
    .filter((migration) => !applied.has(migration.id))
    .toSorted((left, right) => left.id - right.id)

  const at = Date.now()
  for (const migration of pending) {
    await database.batch(toStatements(migration, at), "write")
  }
  return pending
}
