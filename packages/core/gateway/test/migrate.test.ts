import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@libsql/client"
import type { Client as LibsqlClient } from "@libsql/client"
import { Schema } from "effect"
import { applyGatewayMigrations } from "../src/migrate.ts"
import { gatewayMigrations } from "../src/store-migrations.gen.ts"

const decodeJournal = Schema.decodeUnknownSync(Schema.Struct({
  entries: Schema.Array(Schema.Struct({ tag: Schema.String }))
}))

const directories: Array<string> = []
const clients: Array<LibsqlClient> = []

afterEach(async () => {
  for (const client of clients.splice(0)) client.close()
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

/** A file rather than `:memory:`, so a test can reopen the same database and
 *  see what the previous run left in it. */
const openDatabase = async (): Promise<LibsqlClient> => {
  const directory = await mkdtemp(path.join(tmpdir(), "wf-gateway-migrate-"))
  directories.push(directory)
  const client = createClient({ url: `file:${path.join(directory, "gateway.sqlite")}` })
  clients.push(client)
  await client.execute("PRAGMA foreign_keys = ON")
  return client
}

const tableNames = async (database: LibsqlClient): Promise<ReadonlyArray<string>> => {
  const result = await database.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
  )
  return result.rows.map((row) => String(row["name"]))
}

const stampedNames = async (database: LibsqlClient): Promise<ReadonlyArray<string>> => {
  const result = await database.execute("SELECT name FROM gateway_migration ORDER BY id")
  return result.rows.map((row) => String(row["name"]))
}

describe("applyGatewayMigrations", () => {
  test("brings a fresh database up to the declared shape and stamps what it ran", async () => {
    const database = await openDatabase()

    const applied = await applyGatewayMigrations(database)

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
    await applyGatewayMigrations(database)

    const again = await applyGatewayMigrations(database)

    expect(again).toEqual([])
    expect(await stampedNames(database)).toEqual(
      gatewayMigrations.map((migration) => migration.name)
    )
  })

  test("a migration this build does not carry stops the migration rather than guessing", async () => {
    const database = await openDatabase()
    await applyGatewayMigrations(database)
    await database.execute({
      sql: "INSERT INTO gateway_migration (id, name, applied_at) VALUES (?, ?, ?)",
      args: [9999, "9999_from_a_newer_gateway", Date.now()]
    })

    const failure = await applyGatewayMigrations(database).then(
      () => undefined,
      (cause: Error) => cause
    )

    expect(failure?.message).toContain("9999_from_a_newer_gateway")
    expect(failure?.message).toContain("newer gateway")
  })

  test("a renamed applied migration stops the migration", async () => {
    const database = await openDatabase()
    await applyGatewayMigrations(database)
    await database.execute({
      sql: "UPDATE gateway_migration SET name = ? WHERE id = ?",
      args: ["0000_renamed_after_the_fact", 0]
    })

    const failure = await applyGatewayMigrations(database).then(
      () => undefined,
      (cause: Error) => cause
    )

    expect(failure?.message).toContain("renamed or rewritten")
  })
})

// The two index shapes that drizzle-kit only just manages to express are worth
// asserting against a real engine: a mangled expression or a dropped predicate
// would still generate, still apply, and only show up as a duplicate row much
// later.
describe("the declared schema", () => {
  const insertTenant = (database: LibsqlClient) =>
    database.execute({
      sql: "INSERT INTO gateway_tenant (id, name, created_at) VALUES (?, ?, ?)",
      args: ["tenant", "Tenant", 0]
    })

  const insertProfile = (database: LibsqlClient, id: string, isDefault: number) =>
    database.execute({
      sql: `INSERT INTO gateway_access_profile (id, tenant_id, name, is_default, created_at, updated_at)
            VALUES (?, 'tenant', ?, ?, 0, 0)`,
      args: [id, id, isDefault]
    })

  const insertTool = (database: LibsqlClient, subject: string | null) =>
    database.execute({
      sql: `INSERT INTO gateway_access_profile_tool
              (access_profile_id, owner, subject, integration, connection_name, tool)
            VALUES ('profile', 'user', ?, 'gmail', 'work', 'send')`,
      args: [subject]
    })

  test("holds one route per tool even when the route has no subject", async () => {
    const database = await openDatabase()
    await applyGatewayMigrations(database)
    await insertTenant(database)
    await insertProfile(database, "profile", 0)
    await insertTool(database, null)

    // The primary key admits this row — SQLite counts two nulls as two keys.
    // The coalescing unique index is what refuses it.
    const failure = await insertTool(database, null).then(
      () => undefined,
      (cause: Error) => cause
    )

    expect(failure).toBeDefined()
    const rows = await database.execute("SELECT count(*) AS total FROM gateway_access_profile_tool")
    expect(rows.rows[0]?.["total"]).toBe(1)
  })

  test("keeps subject-scoped routes distinct from the unscoped one", async () => {
    const database = await openDatabase()
    await applyGatewayMigrations(database)
    await insertTenant(database)
    await insertProfile(database, "profile", 0)

    await insertTool(database, null)
    await insertTool(database, "sebastian")
    await insertTool(database, "mokronos")

    const rows = await database.execute("SELECT count(*) AS total FROM gateway_access_profile_tool")
    expect(rows.rows[0]?.["total"]).toBe(3)
  })

  test("holds one default access profile per tenant, and any number of non-defaults", async () => {
    const database = await openDatabase()
    await applyGatewayMigrations(database)
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

  /** Regenerating the SQL without re-embedding it would leave the runtime
   *  applying yesterday's shape while `db/schema.ts` describes today's. Both
   *  halves of `bun run db:generate` are one step; this is what says so. */
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
