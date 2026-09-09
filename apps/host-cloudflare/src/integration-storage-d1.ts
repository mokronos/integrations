import { createHmac } from "node:crypto"
import { applySchema, CredentialStore, Database, openValue, sealValue, SqlValue, StorageError, type IntegrationStorage, type SqlRow, type SqlStatement } from "@integrations/integrations"
import { Effect, Layer, Option, Predicate, Schema } from "effect"
import type { D1Cell, D1DatabaseLike } from "./cloudflare.ts"

const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Schema.Record(Schema.String, SqlValue)))

const toSqlValue = (cell: D1Cell | undefined): SqlValue => {
  if (Predicate.isNullish(cell)) return null
  if (Predicate.isString(cell) || Predicate.isNumber(cell)) return cell
  return new TextDecoder().decode(new Uint8Array(cell))
}

const bind = (statement: SqlStatement, database: D1DatabaseLike) => {
  const prepared = database.prepare(statement.sql)
  const params = statement.params ?? []
  return params.length === 0 ? prepared : prepared.bind(...params)
}

const d1Database = (database: D1DatabaseLike): Database["Service"] => {
  const query = Effect.fn("D1Database.query")((statement: SqlStatement) =>
    Effect.tryPromise({
      try: async (): Promise<ReadonlyArray<Record<string, SqlValue>>> => {
        const bound = bind(statement, database)
        const result = "all" in bound ? await bound.all() : await bound.run()
        return (result.results ?? []).map((row) =>
          Object.fromEntries(
            Object.entries(row).map(([column, cell]) => [column, toSqlValue(cell)])
          )
        )
      },
      catch: (cause) => new StorageError({
        message: `D1 statement failed: ${statement.sql.trim().split("\n")[0] ?? statement.sql}`,
        cause
      })
    }).pipe(
      Effect.flatMap((rows) =>
        decodeRows(rows).pipe(Effect.mapError((cause) =>
          new StorageError({
            message: `Unexpected column shape from: ${statement.sql}`,
            cause
          })
        ))
      )
    )
  )

  const batch = Effect.fn("D1Database.batch")((statements: ReadonlyArray<SqlStatement>) =>
    Effect.forEach(statements, query, { discard: true })
  )

  return { query, batch }
}

export const d1DatabaseLayer = (
  database: D1DatabaseLike
): Layer.Layer<Database, StorageError> =>
  Layer.effect(
    Database,
    Effect.suspend(() => {
      const service = d1Database(database)
      return Effect.as(applySchema(service), service)
    })
  )

export const deriveCredentialKey = (masterKey: Uint8Array): Uint8Array =>
  createHmac("sha256", masterKey).update("integrations-credentials/v1").digest()

const credentialTable = `CREATE TABLE IF NOT EXISTS credential (
     key    TEXT PRIMARY KEY NOT NULL,
     sealed TEXT NOT NULL
   )`

const SealedRow = Schema.Struct({ sealed: Schema.String })
const decodeSealed = Schema.decodeUnknownOption(SealedRow)

export const d1CredentialLayer = (
  database: D1DatabaseLike,
  masterKey: Uint8Array
): Layer.Layer<CredentialStore, StorageError> =>
  Layer.effect(
    CredentialStore,
    Effect.gen(function* () {
      const key = deriveCredentialKey(masterKey)

      yield* Effect.tryPromise({
        try: () => database.prepare(credentialTable).run(),
        catch: (cause) => new StorageError({
          message: "Could not create the D1 credential table",
          cause
        })
      })

      const failure = (action: string, name: string) => (cause: unknown): StorageError =>
        new StorageError({ message: `Could not ${action} credential ${name} in D1`, cause })

      return {
        get: (name) =>
          Effect.tryPromise({
            try: () => database
              .prepare("SELECT sealed FROM credential WHERE key = ?")
              .bind(name)
              .first(),
            catch: failure("load", name)
          }).pipe(
            Effect.flatMap((row) =>
              Option.match(decodeSealed(row), {
                onNone: () => Effect.succeed(Option.none<string>()),
                onSome: (sealed) => Effect.try({
                  try: () => Option.some(openValue(key, sealed.sealed)),
                  catch: failure("open", name)
                })
              })
            )
          ),

        set: (name, value) =>
          Effect.try({
            try: () => sealValue(key, value),
            catch: failure("seal", name)
          }).pipe(
            Effect.flatMap((sealed) => Effect.tryPromise({
              try: () => database
                .prepare(
                  `INSERT INTO credential (key, sealed) VALUES (?, ?)
                     ON CONFLICT (key) DO UPDATE SET sealed = excluded.sealed`
                )
                .bind(name, sealed)
                .run(),
              catch: failure("store", name)
            })),
            Effect.asVoid
          ),

        remove: (name) =>
          Effect.tryPromise({
            try: () => database
              .prepare("DELETE FROM credential WHERE key = ?")
              .bind(name)
              .run(),
            catch: failure("remove", name)
          }).pipe(Effect.asVoid)
      }
    })
  )

export const d1IntegrationStorage = (
  database: D1DatabaseLike,
  masterKey: Uint8Array
): IntegrationStorage => ({
  storage: Layer.mergeAll(
    d1DatabaseLayer(database),
    d1CredentialLayer(database, masterKey)
  )
})

export type { SqlRow }
