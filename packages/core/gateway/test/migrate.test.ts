import { describe, expect, it } from "@effect/vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import { Cause, Context, Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { applyGatewayMigrations } from "../src/migrate.ts"
import { libsqlLayer } from "../src/store.ts"
import { gatewayMigrations } from "../src/store-migrations.gen.ts"
import { temporaryDirectory, testServices } from "./fixtures.ts"

const decodeJournal = Schema.decodeUnknownSync(Schema.Struct({
  entries: Schema.Array(Schema.Struct({ tag: Schema.String }))
}))

/** A fresh database, torn down with the test's scope. */
const database = Effect.gen(function*() {
  const directory = yield* temporaryDirectory("gateway-migrate-")
  const sql = yield* Effect.map(
    Layer.build(libsqlLayer(path.join(directory, "gateway.sqlite"))),
    (context) => Context.get(context, SqlClient.SqlClient)
  )
  yield* sql.unsafe("PRAGMA foreign_keys = ON")
  return sql
})

const namesOf = (sql: SqlClient.SqlClient, query: string) =>
  Effect.map(
    sql.unsafe<{ name: string }>(query),
    (rows) => rows.map((row) => String(row.name))
  )

const tableNames = (sql: SqlClient.SqlClient) =>
  namesOf(sql, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")

const stampedNames = (sql: SqlClient.SqlClient) =>
  namesOf(sql, "SELECT name FROM gateway_migration ORDER BY id")

const declaredNames = gatewayMigrations.map((migration) => migration.name)

/**
 * A migration it cannot make sense of is a defect, not a typed failure, so the
 * refusal is read off the cause rather than the error channel.
 */
const refusal = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.map(Effect.exit(effect), (exit) =>
    exit._tag === "Failure" ? String(Cause.squash(exit.cause)) : "")

describe("applyGatewayMigrations", () => {
  it.effect("brings a fresh database up to the declared shape and stamps what it ran", () =>
    Effect.gen(function*() {
      const sql = yield* database

      const applied = yield* applyGatewayMigrations(sql)

      expect(applied.map((migration) => migration.name)).toEqual(declaredNames)
      expect(yield* stampedNames(sql)).toEqual(declaredNames)
      const tables = yield* tableNames(sql)
      for (const table of [
        "gateway_tenant",
        "gateway_client",
        "gateway_access_profile_tool",
        "gateway_approval_policy_tool",
        "gateway_pending_approval",
        "gateway_tool_snapshot"
      ]) {
        expect(tables).toContain(table)
      }
    }).pipe(Effect.provide(testServices)))

  it.effect("applying an up-to-date database runs nothing", () =>
    Effect.gen(function*() {
      const sql = yield* database
      yield* applyGatewayMigrations(sql)

      expect(yield* applyGatewayMigrations(sql)).toEqual([])
      expect(yield* stampedNames(sql)).toEqual(declaredNames)
    }).pipe(Effect.provide(testServices)))

  it.effect("a migration this build does not carry stops the migration rather than guessing", () =>
    Effect.gen(function*() {
      const sql = yield* database
      yield* applyGatewayMigrations(sql)
      yield* sql.unsafe(
        "INSERT INTO gateway_migration (id, name, applied_at) VALUES (?, ?, ?)",
        [9999, "9999_from_a_newer_gateway", 0]
      )

      const message = yield* refusal(applyGatewayMigrations(sql))

      expect(message).toContain("9999_from_a_newer_gateway")
      expect(message).toContain("newer gateway")
    }).pipe(Effect.provide(testServices)))

  it.effect("a renamed applied migration stops the migration", () =>
    Effect.gen(function*() {
      const sql = yield* database
      yield* applyGatewayMigrations(sql)
      yield* sql.unsafe(
        "UPDATE gateway_migration SET name = ? WHERE id = ?",
        ["0000_renamed_after_the_fact", 0]
      )

      expect(yield* refusal(applyGatewayMigrations(sql))).toContain("renamed or rewritten")
    }).pipe(Effect.provide(testServices)))
})

describe("the declared schema", () => {
  const insertTenant = (sql: SqlClient.SqlClient) =>
    sql.unsafe(
      "INSERT INTO gateway_tenant (id, name, created_at) VALUES (?, ?, ?)",
      ["tenant", "Tenant", 0]
    )

  const insertProfile = (sql: SqlClient.SqlClient, id: string, isDefault: number) =>
    sql.unsafe(
      `INSERT INTO gateway_access_profile (id, tenant_id, name, is_default, created_at, updated_at)
       VALUES (?, 'tenant', ?, ?, 0, 0)`,
      [id, id, isDefault]
    )

  const insertTool = (sql: SqlClient.SqlClient, subject: string | null) =>
    sql.unsafe(
      `INSERT INTO gateway_access_profile_tool
         (access_profile_id, owner, subject, integration, connection_name, tool)
       VALUES ('profile', 'user', ?, 'gmail', 'work', 'send')`,
      [subject]
    )

  const total = (sql: SqlClient.SqlClient, table: string) =>
    Effect.map(
      sql.unsafe<{ total: number }>(`SELECT count(*) AS total FROM ${table}`),
      (rows) => rows[0]?.total
    )

  const seeded = Effect.fnUntraced(function*() {
    const sql = yield* database
    yield* applyGatewayMigrations(sql)
    yield* insertTenant(sql)
    return sql
  })

  it.effect("holds one route per tool even when the route has no subject", () =>
    Effect.gen(function*() {
      const sql = yield* seeded()
      yield* insertProfile(sql, "profile", 0)
      yield* insertTool(sql, null)

      const again = yield* Effect.result(insertTool(sql, null))

      expect(again._tag).toBe("Failure")
      expect(yield* total(sql, "gateway_access_profile_tool")).toBe(1)
    }).pipe(Effect.provide(testServices)))

  it.effect("keeps subject-scoped routes distinct from the unscoped one", () =>
    Effect.gen(function*() {
      const sql = yield* seeded()
      yield* insertProfile(sql, "profile", 0)

      yield* insertTool(sql, null)
      yield* insertTool(sql, "sebastian")
      yield* insertTool(sql, "mokronos")

      expect(yield* total(sql, "gateway_access_profile_tool")).toBe(3)
    }).pipe(Effect.provide(testServices)))

  it.effect("holds one default access profile per tenant, and any number of non-defaults", () =>
    Effect.gen(function*() {
      const sql = yield* seeded()
      yield* insertProfile(sql, "first", 1)
      yield* insertProfile(sql, "second", 0)
      yield* insertProfile(sql, "third", 0)

      expect((yield* Effect.result(insertProfile(sql, "fourth", 1)))._tag).toBe("Failure")
    }).pipe(Effect.provide(testServices)))
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
