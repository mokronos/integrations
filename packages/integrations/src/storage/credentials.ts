import { Cause, Context, Effect, Layer, Option, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import type { SqlError } from "effect/unstable/sql"
import { StorageError } from "../errors.ts"
import type { Encryption } from "./encryption.ts"

export const CredentialKey = Schema.String.check(Schema.isMinLength(1)).pipe(
  Schema.brand("CredentialKey")
)
export type CredentialKey = typeof CredentialKey.Type

export const connectionCredentialKey = (address: string): CredentialKey =>
  CredentialKey.make(`connection:${address}`)

export const oauthClientCredentialKey = (
  owner: string,
  slug: string
): CredentialKey => CredentialKey.make(`oauth-client:${owner}:${slug}`)

export const StoredTokens = Schema.Struct({
  accessToken: Schema.String,
  tokenType: Schema.optional(Schema.String),
  refreshToken: Schema.optional(Schema.String),
  expiresAt: Schema.optional(Schema.Number),
  scope: Schema.optional(Schema.String)
})
export type StoredTokens = typeof StoredTokens.Type

const SealedRow = Schema.Struct({ sealed: Schema.String })
const decodeSealedRows = Schema.decodeUnknownEffect(Schema.Array(SealedRow))

export class CredentialStore extends Context.Service<
  CredentialStore,
  {
    readonly get: (key: CredentialKey) => Effect.Effect<Option.Option<string>, StorageError>
    readonly set: (key: CredentialKey, value: string) => Effect.Effect<void, StorageError>
    readonly remove: (key: CredentialKey) => Effect.Effect<void, StorageError>
  }
>()("@integragents/host/CredentialStore") {
  /** Credentials sealed at rest in the `credential` table of the host's `SqlClient`. */
  static readonly sqlLayer = (
    encryption: Encryption
  ): Layer.Layer<CredentialStore, never, SqlClient.SqlClient> =>
    Layer.effect(CredentialStore, Effect.map(SqlClient.SqlClient, (sql) => sqlCredentialStore(sql, encryption)))

  static readonly memoryLayer: Layer.Layer<CredentialStore> = Layer.effect(
    CredentialStore,
    Effect.sync(() => {
      const values = new Map<string, string>()
      return {
        get: (key) => Effect.sync(() => Option.fromNullishOr(values.get(key))),
        set: (key, value) => Effect.sync(() => {
          values.set(key, value)
        }),
        remove: (key) => Effect.sync(() => {
          values.delete(key)
        })
      }
    })
  )
}

const sqlCredentialStore = (
  sql: SqlClient.SqlClient,
  encryption: Encryption
): CredentialStore["Service"] => {
  const failure = (action: string, key: CredentialKey) =>
    (cause: SqlError.SqlError | Schema.SchemaError | Cause.UnknownError): StorageError =>
      new StorageError({ message: `Could not ${action} credential ${key}: ${cause.message}`, cause })

  return {
    get: Effect.fn("CredentialStore.get")((key: CredentialKey) =>
      sql.unsafe("SELECT sealed FROM credential WHERE key = ?", [key]).pipe(
        Effect.flatMap(decodeSealedRows),
        Effect.flatMap((rows) => {
          const row = rows[0]
          if (row === undefined) return Effect.succeed(Option.none<string>())
          return Effect.try(() => Option.some(encryption.open(row.sealed)))
        }),
        Effect.mapError(failure("open", key))
      )
    ),

    set: Effect.fn("CredentialStore.set")((key: CredentialKey, value: string) =>
      Effect.try(() => encryption.seal(value)).pipe(
        Effect.flatMap((sealed) =>
          sql.unsafe(
            `INSERT INTO credential (key, sealed) VALUES (?, ?)
             ON CONFLICT (key) DO UPDATE SET sealed = excluded.sealed`,
            [key, sealed]
          )
        ),
        Effect.mapError(failure("store", key)),
        Effect.asVoid
      )
    ),

    remove: Effect.fn("CredentialStore.remove")((key: CredentialKey) =>
      sql.unsafe("DELETE FROM credential WHERE key = ?", [key]).pipe(
        Effect.mapError(failure("remove", key)),
        Effect.asVoid
      )
    )
  }
}

export const readTokens = (
  store: CredentialStore["Service"],
  key: CredentialKey
): Effect.Effect<Option.Option<StoredTokens>, StorageError> =>
  store.get(key).pipe(
    Effect.flatMap(Option.match({
      onNone: () => Effect.succeed(Option.none<StoredTokens>()),
      onSome: (raw) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(StoredTokens))(raw).pipe(
          Effect.map(Option.some),
          Effect.mapError((cause) =>
            new StorageError({ message: `Malformed stored tokens for ${key}`, cause })
          )
        )
    }))
  )

export const writeTokens = (
  store: CredentialStore["Service"],
  key: CredentialKey,
  tokens: StoredTokens
): Effect.Effect<void, StorageError> => store.set(key, JSON.stringify(tokens))
