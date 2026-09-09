import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Context, Effect, Exit, Layer, Schema, Scope } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { applyGatewayMigrations } from "../src/migrate.ts"
import { libsqlLayer } from "../src/store.ts"
import { gatewayMigrations } from "../src/store-migrations.gen.ts"

const decodeJournal = Schema.decodeUnknownSync(Schema.Struct({
  entries: Schema.Array(Schema.Struct({ tag: Schema.String }))
}))

const directories: Array<string> = []
const scopes: Array<Scope.Closeable> = []

afterEach(async () => {
  await Promise.all(scopes.splice(0).map((scope) =>
    Effect.runPromise(Scope.close(scope, Exit.void))
  ))
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

/** A fresh database, and a way to run statements against it. */
const openDatabase = async (): Promise<SqlClient.SqlClient> => {
  const directory = await mkdtemp(path.join(tmpdir(), "wf-gateway-migrate-"))
  directories.push(directory)
  const scope = Scope.makeUnsafe()
  scopes.push(scope)
  const sql = await Effect.runPromise(Effect.map(
    Layer.buildWithScope(libsqlLayer(path.join(directory, "gateway.sqlite")), scope),
    (context) => Context.get(context, SqlClient.SqlClient)
  ))
  await Effect.runPromise(sql.unsafe("PRAGMA foreign_keys = ON"))
  return sql
}

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect)

const tableNames = async (sql: SqlClient.SqlClient): Promise<ReadonlyArray<string>> => {
  const rows = await run(sql.unsafe<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
  ))
  return rows.map((row) => String(row.name))
}

const stampedNames = async (sql: SqlClient.SqlClient): Promise<ReadonlyArray<string>> => {
  const rows = await run(sql.unsafe<{ name: string }>(
    "SELECT name FROM gateway_migration ORDER BY id"
  ))
  return rows.map((row) => String(row.name))
}

describe("applyGatewayMigrations", () => {
  test("brings a fresh database up to the declared shape and stamps what it ran", async () => {
    const database = await openDatabase()

    const applied = await run(applyGatewayMigrations(database))

    expect(applied.map((migration) => migration.name)).toEqual(
      gatewayMigrations.map((migration) => migration.name)
    )
    expect(await stampedNames(database)).toEqual(
      gatewayMigrations.map((migration) => migration.name)
    )
    const tables = await tableNames(database)
    expect(tables).toContain("gateway_tenant")
    expect(tables).toContain("gateway_client")
    expect(tables).toContain("gateway_access_profile_tool")
    expect(tables).toContain("gateway_approval_policy_tool")
    expect(tables).toContain("gateway_pending_approval")
    expect(tables).toContain("gateway_tool_snapshot")
  })

  test("applying an up-to-date database runs nothing", async () => {
    const database = await openDatabase()
    await run(applyGatewayMigrations(database))

    const again = await run(applyGatewayMigrations(database))

    expect(again).toEqual([])
    expect(await stampedNames(database)).toEqual(
      gatewayMigrations.map((migration) => migration.name)
    )
  })

  test("a migration this build does not carry stops the migration rather than guessing", async () => {
    const database = await openDatabase()
    await run(applyGatewayMigrations(database))
    await run(database.unsafe(
      "INSERT INTO gateway_migration (id, name, applied_at) VALUES (?, ?, ?)",
      [9999, "9999_from_a_newer_gateway", Date.now()]
    ))

    const failure = await run(applyGatewayMigrations(database)).then(
      () => undefined,
      (cause: Error) => cause
    )

    expect(failure?.message).toContain("9999_from_a_newer_gateway")
    expect(failure?.message).toContain("newer gateway")
  })

  test("a renamed applied migration stops the migration", async () => {
    const database = await openDatabase()
    await run(applyGatewayMigrations(database))
    await run(database.unsafe(
      "UPDATE gateway_migration SET name = ? WHERE id = ?",
      ["0000_renamed_after_the_fact", 0]
    ))

    const failure = await run(applyGatewayMigrations(database)).then(
      () => undefined,
      (cause: Error) => cause
    )

    expect(failure?.message).toContain("renamed or rewritten")
  })
})

describe("the declared schema", () => {
  const insertTenant = (sql: SqlClient.SqlClient) =>
    run(sql.unsafe(
      "INSERT INTO gateway_tenant (id, name, created_at) VALUES (?, ?, ?)",
      ["tenant", "Tenant", 0]
    ))

  const insertProfile = (sql: SqlClient.SqlClient, id: string, isDefault: number) =>
    run(sql.unsafe(
      `INSERT INTO gateway_access_profile (id, tenant_id, name, is_default, created_at, updated_at)
       VALUES (?, 'tenant', ?, ?, 0, 0)`,
      [id, id, isDefault]
    ))

  const insertTool = (sql: SqlClient.SqlClient, subject: string | null) =>
    run(sql.unsafe(
      `INSERT INTO gateway_access_profile_tool
         (access_profile_id, owner, subject, integration, connection_name, tool)
       VALUES ('profile', 'user', ?, 'gmail', 'work', 'send')`,
      [subject]
    ))

  test("holds one route per tool even when the route has no subject", async () => {
    const database = await openDatabase()
    await run(applyGatewayMigrations(database))
    await insertTenant(database)
    await insertProfile(database, "profile", 0)
    await insertTool(database, null)

    const failure = await insertTool(database, null).then(
      () => undefined,
      (cause: Error) => cause
    )

    expect(failure).toBeDefined()
    const rows = await run(database.unsafe<{ total: number }>(
      "SELECT count(*) AS total FROM gateway_access_profile_tool"
    ))
    expect(rows[0]?.total).toBe(1)
  })

  test("keeps subject-scoped routes distinct from the unscoped one", async () => {
    const database = await openDatabase()
    await run(applyGatewayMigrations(database))
    await insertTenant(database)
    await insertProfile(database, "profile", 0)

    await insertTool(database, null)
    await insertTool(database, "sebastian")
    await insertTool(database, "mokronos")

    const rows = await run(database.unsafe<{ total: number }>(
      "SELECT count(*) AS total FROM gateway_access_profile_tool"
    ))
    expect(rows[0]?.total).toBe(3)
  })

  test("holds one default access profile per tenant, and any number of non-defaults", async () => {
    const database = await openDatabase()
    await run(applyGatewayMigrations(database))
    await insertTenant(database)
    await insertProfile(database, "first", 1)
    await insertProfile(database, "second", 0)
    await insertProfile(database, "third", 0)

    const failure = await insertProfile(database, "fourth", 1).then(
      () => undefined,
      (cause: Error) => cause
    )

    expect(failure).toBeDefined()
  })
})

describe("the embedded migrations", () => {
  const migrationsDirectory = path.join(import.meta.dirname, "..", "db", "migrations")

  test("carry exactly what db/migrations holds on disk", () => {
    for (const migration of gatewayMigrations) {
      const onDisk = readFileSync(path.join(migrationsDirectory, `${migration.name}.sql`), "utf8")
        .split("--> statement-breakpoint")
        .map((statement) => statement.trim())
        .filter((statement) => statement.length > 0)
      expect(migration.statements).toEqual(onDisk)
    }
  })

  test("cover every entry in the drizzle journal", () => {
    const journal = decodeJournal(
      JSON.parse(readFileSync(path.join(migrationsDirectory, "meta", "_journal.json"), "utf8"))
    )
    expect(gatewayMigrations.map((migration) => migration.name)).toEqual(
      journal.entries.map((entry) => entry.tag)
    )
  })
})
