import { describe, expect, it } from "@effect/vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import { Cause, Context, Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { applyMigrations, integrationMigrationSet } from "@integragents/host"
import type { MigrationSet } from "@integragents/host"
import { applyGatewayMigrations, gatewayMigrationSet } from "../src/migrate.ts"
import { libsqlLayer } from "../src/store.ts"
import { gatewayMigrations } from "../src/store-migrations.gen.ts"
import { temporaryDirectory, testServices } from "./fixtures.ts"

const decodeJournal = Schema.decodeUnknownSync(
  Schema.Struct({
    entries: Schema.Array(Schema.Struct({ tag: Schema.String }))
  })
)

/** A fresh database, torn down with the test's scope. */
const database = Effect.gen(function* () {
  const directory = yield* temporaryDirectory("gateway-migrate-")
  const sql = yield* Effect.map(Layer.build(libsqlLayer(path.join(directory, "gateway.sqlite"))), (context) =>
    Context.get(context, SqlClient.SqlClient)
  )
  yield* sql.unsafe("PRAGMA foreign_keys = ON")
  return sql
})

const namesOf = (sql: SqlClient.SqlClient, query: string) =>
  Effect.map(sql.unsafe<{ name: string }>(query), (rows) => rows.map((row) => String(row.name)))

const tableNames = (sql: SqlClient.SqlClient) =>
  namesOf(sql, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")

const stampedNames = (sql: SqlClient.SqlClient) => namesOf(sql, "SELECT name FROM gateway_migration ORDER BY id")

const declaredNames = gatewayMigrations.map((migration) => migration.name)

/**
 * A migration it cannot make sense of is a defect, not a typed failure, so the
 * refusal is read off the cause rather than the error channel.
 */
const refusal = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.map(Effect.exit(effect), (exit) => (exit._tag === "Failure" ? String(Cause.squash(exit.cause)) : ""))

describe("applyGatewayMigrations", () => {
  it.effect("brings a fresh database up to the declared shape and stamps what it ran", () =>
    Effect.gen(function* () {
      const sql = yield* database

      const applied = yield* applyGatewayMigrations(sql)

      expect(applied.map((migration) => migration.name)).toEqual(declaredNames)
      expect(yield* stampedNames(sql)).toEqual(declaredNames)
      const tables = yield* tableNames(sql)
      for (const table of [
        "gateway_tenant",
        "gateway_profile",
        "gateway_profile_tool",
        "gateway_pending_approval",
        "gateway_tool_snapshot"
      ]) {
        expect(tables).toContain(table)
      }
    }).pipe(Effect.provide(testServices))
  )

  it.effect("applying an up-to-date database runs nothing", () =>
    Effect.gen(function* () {
      const sql = yield* database
      yield* applyGatewayMigrations(sql)

      expect(yield* applyGatewayMigrations(sql)).toEqual([])
      expect(yield* stampedNames(sql)).toEqual(declaredNames)
    }).pipe(Effect.provide(testServices))
  )

  it.effect("a migration this build does not carry stops the migration rather than guessing", () =>
    Effect.gen(function* () {
      const sql = yield* database
      yield* applyGatewayMigrations(sql)
      yield* sql.unsafe("INSERT INTO gateway_migration (id, name, applied_at) VALUES (?, ?, ?)", [
        9999,
        "9999_from_a_newer_gateway",
        0
      ])

      const message = yield* refusal(applyGatewayMigrations(sql))

      expect(message).toContain("9999_from_a_newer_gateway")
      expect(message).toContain("newer build")
    }).pipe(Effect.provide(testServices))
  )

  it.effect("a renamed applied migration stops the migration", () =>
    Effect.gen(function* () {
      const sql = yield* database
      yield* applyGatewayMigrations(sql)
      yield* sql.unsafe("UPDATE gateway_migration SET name = ? WHERE id = ?", ["0000_renamed_after_the_fact", 0])

      expect(yield* refusal(applyGatewayMigrations(sql))).toContain("renamed or rewritten")
    }).pipe(Effect.provide(testServices))
  )
})

describe("the declared schema", () => {
  const insertTenant = (sql: SqlClient.SqlClient) =>
    sql.unsafe("INSERT INTO gateway_tenant (id, name, created_at) VALUES (?, ?, ?)", ["tenant", "Tenant", 0])

  const insertProfile = (sql: SqlClient.SqlClient) =>
    sql.unsafe(
      `INSERT INTO gateway_profile (id, tenant_id, name, capabilities, created_at)
       VALUES ('profile', 'tenant', 'profile', '[]', 0)`
    )

  const insertTool = (sql: SqlClient.SqlClient, subject: string | null) =>
    sql.unsafe(
      `INSERT INTO gateway_profile_tool
         (profile_id, owner, subject, integration, connection_name, tool, decision)
       VALUES ('profile', 'user', ?, 'gmail', 'work', 'send', 'allow')`,
      [subject]
    )

  const total = (sql: SqlClient.SqlClient, table: string) =>
    Effect.map(sql.unsafe<{ total: number }>(`SELECT count(*) AS total FROM ${table}`), (rows) => rows[0]?.total)

  const seeded = Effect.fnUntraced(function* () {
    const sql = yield* database
    yield* applyGatewayMigrations(sql)
    yield* insertTenant(sql)
    return sql
  })

  it.effect("holds one route per tool even when the route has no subject", () =>
    Effect.gen(function* () {
      const sql = yield* seeded()
      yield* insertProfile(sql)
      yield* insertTool(sql, null)

      const again = yield* Effect.result(insertTool(sql, null))

      expect(again._tag).toBe("Failure")
      expect(yield* total(sql, "gateway_profile_tool")).toBe(1)
    }).pipe(Effect.provide(testServices))
  )

  it.effect("keeps subject-scoped routes distinct from the unscoped one", () =>
    Effect.gen(function* () {
      const sql = yield* seeded()
      yield* insertProfile(sql)

      yield* insertTool(sql, null)
      yield* insertTool(sql, "sebastian")
      yield* insertTool(sql, "mokronos")

      expect(yield* total(sql, "gateway_profile_tool")).toBe(3)
    }).pipe(Effect.provide(testServices))
  )
})

describe("the embedded migrations", () => {
  const migrationsDirectory = path.join(import.meta.dirname, "..", "db", "migrations")

  it("carry exactly what db/migrations holds on disk", () => {
    for (const migration of gatewayMigrations) {
      const onDisk = readFileSync(path.join(migrationsDirectory, `${migration.name}.sql`), "utf8")
        .split("--> statement-breakpoint")
        .map((statement) => statement.trim())
        .filter((statement) => statement.length > 0)
      expect(migration.statements).toEqual(onDisk)
    }
  })

  it("cover every entry in the drizzle journal", () => {
    const journal = decodeJournal(
      JSON.parse(readFileSync(path.join(migrationsDirectory, "meta", "_journal.json"), "utf8"))
    )
    expect(declaredNames).toEqual(journal.entries.map((entry) => entry.tag))
  })
})

describe("upgrading a database that holds data", () => {
  type Row = Record<string, string | number | null>

  const columnsOf = (sql: SqlClient.SqlClient, table: string) =>
    sql.unsafe<{ name: string; type: string }>(`SELECT name, type FROM pragma_table_info('${table}')`)

  const literalFor = (type: string): string => {
    const affinity = type.toLowerCase()
    if (affinity.includes("blob")) return "x'00'"
    if (["int", "real", "floa", "doub", "num"].some((part) => affinity.includes(part))) return "1"
    return "'seed'"
  }

  const rowsOf = (sql: SqlClient.SqlClient, table: string, columns: ReadonlyArray<string>) =>
    sql.unsafe<Row>(`SELECT ${columns.map((column) => `"${column}"`).join(", ")} FROM "${table}"`)

  /** One row in every table, every column filled, so every foreign key points at a seeded row. */
  const seed = Effect.fnUntraced(function* (sql: SqlClient.SqlClient, set: MigrationSet) {
    const tables = (yield* tableNames(sql)).filter((table) => table !== set.ledger)
    const seeded = new Map<string, { readonly columns: ReadonlyArray<string>; readonly rows: ReadonlyArray<Row> }>()
    yield* sql.unsafe("PRAGMA foreign_keys = OFF")
    for (const table of tables) {
      const columns = yield* columnsOf(sql, table)
      yield* sql.unsafe(
        `INSERT INTO "${table}" (${columns.map((column) => `"${column.name}"`).join(", ")}) ` +
          `VALUES (${columns.map((column) => literalFor(column.type)).join(", ")})`
      )
    }
    yield* sql.unsafe("PRAGMA foreign_keys = ON")
    for (const table of tables) {
      const columns = (yield* columnsOf(sql, table)).map((column) => column.name)
      seeded.set(table, { columns, rows: yield* rowsOf(sql, table, columns) })
    }
    return seeded
  })

  for (const set of [gatewayMigrationSet, integrationMigrationSet]) {
    it.effect(`${set.ledger}: the newest migration keeps the rows written before it`, () =>
      Effect.gen(function* () {
        const sql = yield* database
        yield* applyMigrations(sql, { ...set, migrations: set.migrations.slice(0, -1) })
        const seeded = yield* seed(sql, set)
        expect(seeded.size).toBeGreaterThan(0)

        yield* applyMigrations(sql, set)

        const tables = yield* tableNames(sql)
        for (const [table, before] of seeded) {
          if (!tables.includes(table)) continue
          const remaining = new Set((yield* columnsOf(sql, table)).map((column) => column.name))
          const kept = before.columns.filter((column) => remaining.has(column))
          const expected = before.rows.map((row) => Object.fromEntries(kept.map((column) => [column, row[column]])))
          expect({ table, rows: yield* rowsOf(sql, table, kept) }).toEqual({ table, rows: expected })
        }
      }).pipe(Effect.provide(testServices))
    )
  }
})
