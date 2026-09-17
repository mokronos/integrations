import { Clock, Effect, Schema } from "effect"
import type { SqlError } from "effect/unstable/sql"
import type { SqlClient } from "effect/unstable/sql"

export interface Migration {
  /** Journal index. Stamped in the ledger, so it never shifts. */
  readonly id: number
  readonly name: string
  readonly statements: ReadonlyArray<string>
}

export interface MigrationSet {
  /** The table that records what ran. One per owner sharing a database. */
  readonly ledger: string
  readonly migrations: ReadonlyArray<Migration>
}

const AppliedRow = Schema.Struct({ id: Schema.Int, name: Schema.String })
const decodeApplied = Schema.decodeUnknownSync(Schema.Array(AppliedRow))

/**
 * Refuses to touch a database whose ledger this build cannot account for.
 * Either it was migrated by a newer build, or an applied migration was
 * rewritten under us; both mean the safe move is to stop rather than guess.
 */
const assertLedgerIsKnown = (set: MigrationSet, applied: ReadonlyArray<{ id: number; name: string }>): void => {
  const known = new Map(set.migrations.map((migration) => [migration.id, migration.name]))
  for (const { id, name } of applied) {
    const expected = known.get(id)
    if (expected === undefined) {
      throw new Error(
        `The database has applied migration ${id} (${name}) in ${set.ledger}, which this build does not carry. ` +
          `It was migrated by a newer build; run that one instead.`
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
 * Brings the database up to the shape a migration set declares.
 *
 * Effect's own Migrator does not fit here: it treats the highest applied id as
 * the watermark and skips anything at or below it, so a baseline at id 0
 * would never run on a fresh database, and it has no answer for a ledger
 * carrying migrations this build does not know about.
 */
export const applyMigrations = Effect.fn("Migrations.apply")(function*(
  sql: SqlClient.SqlClient,
  set: MigrationSet
): Effect.fn.Return<ReadonlyArray<Migration>, SqlError.SqlError> {
  yield* sql.unsafe(
    `CREATE TABLE IF NOT EXISTS ${set.ledger} (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)`
  )
  const rows = yield* sql.unsafe<{ id: number; name: string }>(
    `SELECT id, name FROM ${set.ledger} ORDER BY id`
  )
  const applied = decodeApplied(rows.map((row) => ({ id: row.id, name: row.name })))
  assertLedgerIsKnown(set, applied)
  const done = new Set(applied.map((row) => row.id))

  const pending = set.migrations
    .filter((migration) => !done.has(migration.id))
    .toSorted((left, right) => left.id - right.id)

  const at = yield* Clock.currentTimeMillis
  for (const migration of pending) {
    yield* sql.withTransaction(Effect.gen(function*() {
      for (const statement of migration.statements) {
        yield* sql.unsafe(statement)
      }
      yield* sql.unsafe(
        `INSERT INTO ${set.ledger} (id, name, applied_at) VALUES (?, ?, ?)`,
        [migration.id, migration.name, at]
      )
    }))
  }
  return pending
})
