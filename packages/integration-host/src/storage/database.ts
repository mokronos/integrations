import { mkdirSync } from "node:fs"
import path from "node:path"
import { createClient } from "@libsql/client"
import type { Client as LibsqlClient, Value as LibsqlValue } from "@libsql/client"
import { Context, Effect, Layer, Predicate, Schema } from "effect"
import { describeCause, StorageError } from "../errors.ts"

/** The single SQL seam the host persists through.
 *
 *  Everything above this service speaks parameterised statements and decoded
 *  rows, so a Cloudflare D1 binding satisfies the same contract as a local
 *  libsql file without any caller knowing which one it got. That replaces the
 *  ORM runtime-schema layer this host used to need. */

/** What a bound parameter and a returned column may hold. Booleans are stored
 *  as 0/1 and structured values as JSON text, so this is the whole set. */
export const SqlValue = Schema.Union([Schema.String, Schema.Number, Schema.Null])
export type SqlValue = typeof SqlValue.Type

export const SqlRow = Schema.Record(Schema.String, SqlValue)
export type SqlRow = typeof SqlRow.Type

export interface SqlStatement {
  readonly sql: string
  readonly params?: ReadonlyArray<SqlValue>
}

const decodeRows = Schema.decodeUnknownEffect(Schema.Array(SqlRow))

export class Database extends Context.Service<
  Database,
  {
    /** Runs one statement and returns its rows. A write returns no rows. */
    readonly query: (statement: SqlStatement) => Effect.Effect<ReadonlyArray<SqlRow>, StorageError>
    /** Runs statements in order inside one transaction. */
    readonly batch: (statements: ReadonlyArray<SqlStatement>) => Effect.Effect<void, StorageError>
  }
>()("@mokronos/integration-host/Database") {}

/** Normalises a driver result into plain decodable objects. libsql rows carry
 *  positional keys alongside named ones, so the column list is what makes a row
 *  a record rather than an array. */
const toRecords = (
  columns: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<SqlValue>>
): ReadonlyArray<Record<string, SqlValue>> =>
  rows.map((row) =>
    Object.fromEntries(columns.map((column, index) => [column, row[index] ?? null]))
  )

/** One value as the driver hands it back, narrowed to what a column may hold.
 *
 *  libsql widens a cell to include `bigint`, `boolean` and buffers even for a
 *  schema that stores none of them, so the driver's union is collapsed here
 *  rather than carried through every read. */
const cell = (value: LibsqlValue | undefined): SqlValue => {
  if (Predicate.isString(value) || Predicate.isNumber(value)) return value
  if (Predicate.isBigInt(value)) return Number(value)
  if (Predicate.isBoolean(value)) return value ? 1 : 0
  if (Predicate.isNullish(value)) return null
  return String(value)
}

const storageFailure = (sql: string) => (cause: unknown): StorageError =>
  new StorageError({
    message: `Statement failed: ${sql.trim().split("\n")[0] ?? sql} (${describeCause(cause)})`,
    cause
  })

const libsqlDatabase = (client: LibsqlClient): Database["Service"] => {
  const query = Effect.fn("Database.query")((statement: SqlStatement) =>
    Effect.tryPromise({
      try: async () => {
        const result = await client.execute({
          sql: statement.sql,
          args: [...(statement.params ?? [])]
        })
        return toRecords(
          result.columns,
          result.rows.map((row) => result.columns.map((_, index) => cell(row[index])))
        )
      },
      catch: storageFailure(statement.sql)
    }).pipe(Effect.flatMap((records) =>
      decodeRows(records).pipe(Effect.mapError((cause) =>
        new StorageError({
          message: `Unexpected column shape from: ${statement.sql}`,
          cause
        })
      ))
    ))
  )

  const batch = Effect.fn("Database.batch")((statements: ReadonlyArray<SqlStatement>) =>
    Effect.tryPromise({
      try: async () => {
        await client.batch(
          statements.map((statement) => ({
            sql: statement.sql,
            args: [...(statement.params ?? [])]
          })),
          "write"
        )
      },
      catch: storageFailure(statements[0]?.sql ?? "batch")
    })
  )

  return { query, batch }
}

/** The schema every table lives in. Applied on layer construction: a fresh file
 *  and an existing one converge on the same shape, and there is no migration
 *  history to carry because the host owns this database outright. */
const schemaStatements: ReadonlyArray<string> = [
  `CREATE TABLE IF NOT EXISTS integration (
     slug           TEXT PRIMARY KEY NOT NULL,
     name           TEXT NOT NULL,
     description    TEXT NOT NULL DEFAULT '',
     kind           TEXT NOT NULL,
     endpoint       TEXT,
     spec_source    TEXT,
     spec_format    TEXT,
     base_url       TEXT,
     display_url    TEXT,
     auth_methods   TEXT NOT NULL DEFAULT '[]',
     created_at     INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS spec_document (
     source      TEXT PRIMARY KEY NOT NULL,
     content     TEXT NOT NULL,
     fetched_at  INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS connection (
     owner              TEXT NOT NULL,
     integration        TEXT NOT NULL,
     name               TEXT NOT NULL,
     template           TEXT NOT NULL,
     provider           TEXT NOT NULL,
     identity_label     TEXT,
     description        TEXT,
     oauth_client       TEXT,
     oauth_client_owner TEXT,
     oauth_scope        TEXT,
     expires_at         INTEGER,
     created_at         INTEGER NOT NULL,
     PRIMARY KEY (owner, integration, name),
     FOREIGN KEY (integration) REFERENCES integration(slug) ON DELETE CASCADE
   )`,
  `CREATE TABLE IF NOT EXISTS oauth_client (
     owner                        TEXT NOT NULL,
     slug                         TEXT NOT NULL,
     integration                  TEXT NOT NULL,
     client_id                    TEXT NOT NULL,
     authorization_url            TEXT NOT NULL,
     token_url                    TEXT NOT NULL,
     registration_endpoint        TEXT,
     issuer                       TEXT,
     resource                     TEXT,
     scopes                       TEXT NOT NULL DEFAULT '[]',
     token_auth_methods           TEXT NOT NULL DEFAULT '[]',
     created_at                   INTEGER NOT NULL,
     PRIMARY KEY (owner, slug)
   )`,
  `CREATE TABLE IF NOT EXISTS oauth_flow (
     state         TEXT PRIMARY KEY NOT NULL,
     owner         TEXT NOT NULL,
     integration   TEXT NOT NULL,
     connection    TEXT NOT NULL,
     template      TEXT NOT NULL,
     client_owner  TEXT NOT NULL,
     client_slug   TEXT NOT NULL,
     code_verifier TEXT NOT NULL,
     redirect_uri  TEXT NOT NULL,
     resource      TEXT,
     scopes        TEXT NOT NULL DEFAULT '[]',
     created_at    INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS connection_by_integration
     ON connection (integration, owner)`
]

/** Brings a freshly opened database up to the shape above. Runs against the
 *  service value rather than the tag, so a layer can apply it to the handle it
 *  just built without depending on itself. */
export const applySchema = (
  database: Database["Service"]
): Effect.Effect<void, StorageError> =>
  Effect.forEach(schemaStatements, (sql) => database.query({ sql }), { discard: true })

export interface LibsqlDatabaseOptions {
  /** Directory the SQLite file lives in. Created if absent, owner-only. */
  readonly directory: string
  readonly fileName?: string
}

/** A local libsql-backed database in a directory the host owns. */
export const libsqlLayer = (
  options: LibsqlDatabaseOptions
): Layer.Layer<Database, StorageError> =>
  Layer.effect(
    Database,
    Effect.acquireRelease(
      Effect.try({
        try: () => {
          mkdirSync(options.directory, { recursive: true, mode: 0o700 })
          return createClient({
            url: `file:${path.join(options.directory, options.fileName ?? "integrations.sqlite")}`
          })
        },
        catch: (cause) => new StorageError({
          message: `Could not open the integration database in ${options.directory}`,
          cause
        })
      }),
      (client) => Effect.sync(() => client.close())
    ).pipe(
      Effect.tap((client) => Effect.tryPromise({
        try: async () => {
          await client.execute("PRAGMA foreign_keys = ON")
          await client.execute("PRAGMA journal_mode = WAL")
        },
        catch: (cause) => new StorageError({
          message: "Could not configure the integration database",
          cause
        })
      })),
      Effect.map(libsqlDatabase),
      Effect.tap(applySchema)
    )
  )

/** An in-memory database, for tests and for probing without touching disk. */
export const memoryLayer: Layer.Layer<Database, StorageError> = Layer.effect(
  Database,
  Effect.acquireRelease(
    Effect.sync(() => createClient({ url: ":memory:" })),
    (client) => Effect.sync(() => client.close())
  ).pipe(
    Effect.map(libsqlDatabase),
    Effect.tap(applySchema)
  )
)
