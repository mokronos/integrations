import type { Client as LibsqlClient, InStatement } from "@libsql/client"
import { Schema } from "effect"
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

const readApplied = async (database: LibsqlClient): Promise<Map<number, string>> => {
  const result = await database.execute("SELECT id, name FROM gateway_migration ORDER BY id")
  const rows = decodeApplied(
    result.rows.map((row) => ({ id: row["id"], name: row["name"] }))
  )
  return new Map(rows.map((row) => [row.id, row.name]))
}

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
