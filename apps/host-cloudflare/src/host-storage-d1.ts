import { createHmac } from "node:crypto"
import { applySchema, CredentialStore, Database, openValue, sealValue, SqlValue, StorageError, type HostStorage, type SqlRow, type SqlStatement } from "@mokronos/integration-host"
import { Effect, Layer, Option, Predicate, Schema } from "effect"
import type { D1Cell, D1DatabaseLike } from "./cloudflare.ts"

/**
 * The integration host's storage on Cloudflare, replacing the local pair of a
 * SQLite file and a sealed credential file.
 *
 * The host exposes exactly two storage seams — {@link Database} for rows and
 * {@link CredentialStore} for secrets — so this file is the whole of the
 * Cloudflare port. Nothing above those two seams changes, and there is no ORM
 * runtime-schema layer to reproduce: the host speaks parameterised SQL, which
 * D1 accepts directly.
 */

const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Schema.Record(Schema.String, SqlValue)))

/** D1 returns `ArrayBuffer` for blob columns. The host stores only text,
 *  numbers and nulls, so anything else is a column it did not write and is
 *  rendered rather than dropped. */
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
        // A parameterless statement has no `all`; DDL runs through `run`.
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

  /**
   * Statements run in order but not atomically.
   *
   * D1 rejects a raw `BEGIN`, and its batch API is not exposed through the
   * structural binding this Worker compiles against. The host issues a batch in
   * exactly two places — removing an integration with its connections, and
   * nothing else — so a partial failure leaves an orphaned row rather than a
   * corrupt catalog, and re-running the removal cleans it up.
   */
  const batch = Effect.fn("D1Database.batch")((statements: ReadonlyArray<SqlStatement>) =>
    Effect.forEach(statements, query, { discard: true })
  )

  return { query, batch }
}

/** Rows on a D1 binding. The schema is applied on first construction, exactly
 *  as the local layer does. */
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

/**
 * Derives the credential key from the gateway's master key.
 *
 * There is no keyfile to mint on Workers, and a second secret to provision
 * would be one more thing to lose. HMAC domain separation keeps this key
 * distinct from every other use of the master key while remaining fully
 * determined by it.
 */
export const deriveCredentialKey = (masterKey: Buffer): Buffer =>
  createHmac("sha256", masterKey).update("integrations-credentials/v1").digest()

const credentialTable = `CREATE TABLE IF NOT EXISTS credential (
     key    TEXT PRIMARY KEY NOT NULL,
     sealed TEXT NOT NULL
   )`

const SealedRow = Schema.Struct({ sealed: Schema.String })
const decodeSealed = Schema.decodeUnknownOption(SealedRow)

/** Secrets on the same D1 binding, sealed with the derived key.
 *
 *  The envelope format is the local store's — AES-256-GCM with the same
 *  additional data, so there is one sealing implementation rather than two — but
 *  the *keys* differ: the local store mints a keyfile, and this one derives from
 *  the gateway's master key. A value sealed by one deployment is therefore not
 *  readable by the other, and moving between them means reconnecting. */
export const d1CredentialLayer = (
  database: D1DatabaseLike,
  masterKey: Buffer
): Layer.Layer<CredentialStore, StorageError> =>
  Layer.effect(
    CredentialStore,
    Effect.gen(function* () {
      const key = deriveCredentialKey(masterKey)

      // The table is created once, when the layer is built, rather than lazily
      // per call: the layer is constructed inside a request that already has
      // I/O to spend.
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

/** The complete {@link HostStorage} for a D1 deployment. */
export const d1HostStorage = (
  database: D1DatabaseLike,
  masterKey: Buffer
): HostStorage => ({
  storage: Layer.mergeAll(
    d1DatabaseLayer(database),
    d1CredentialLayer(database, masterKey)
  )
})

export type { SqlRow }
