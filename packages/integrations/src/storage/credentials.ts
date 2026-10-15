import { Cause, Context, Effect, Layer, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"
import type { SqlError } from "effect/sql"
import { StorageError } from "../errors.ts"
import type { Encryption } from "./encryption.ts"

export const CredentialKey = Schema.String.check(Schema.isMinLength(1)).pipe(Schema.brand("CredentialKey"))
export type CredentialKey = typeof CredentialKey.Type

export const connectionCredentialKey = (address: string): CredentialKey => CredentialKey.make(`connection:${address}`)

export const oauthClientCredentialKey = (owner: string, slug: string): CredentialKey =>
  CredentialKey.make(`oauth-client:${owner}:${slug}`)

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
const ClaimRow = Schema.Struct({ claimed_at: Schema.NullOr(Schema.Number) })
const decodeClaimRows = Schema.decodeUnknownEffect(Schema.Array(ClaimRow))

/** Whether the caller now holds a credential's one claim, someone else does, or there is nothing to claim. */
export type CredentialClaim =
  | { readonly _tag: "Claimed" }
  | { readonly _tag: "Held"; readonly since: number }
  | { readonly _tag: "Missing" }

export class CredentialStore extends Context.Service<
  CredentialStore,
  {
    readonly get: (key: CredentialKey) => Effect.Effect<Option.Option<string>, StorageError>
    readonly set: (key: CredentialKey, value: string) => Effect.Effect<void, StorageError>
    readonly remove: (key: CredentialKey) => Effect.Effect<void, StorageError>
    /**
     * Takes the credential's single claim, so work that spends it, such as a
     * rotating refresh token, happens once. Writing the credential with `set`
     * drops any claim on it.
     */
    readonly claim: (key: CredentialKey, claim: string, at: number) => Effect.Effect<CredentialClaim, StorageError>
    /**
     * Releases `claim`, replacing the value when one is given. False, and
     * nothing written, when the claim was no longer held.
     */
    readonly settleClaim: (
      key: CredentialKey,
      claim: string,
      value: Option.Option<string>
    ) => Effect.Effect<boolean, StorageError>
  }
>()("@integragents/host/CredentialStore") {
  /** Credentials sealed at rest in the `credential` table of the host's `SqlClient`. */
  static readonly sqlLayer = (encryption: Encryption): Layer.Layer<CredentialStore, never, SqlClient.SqlClient> =>
    Layer.effect(
      CredentialStore,
      Effect.map(SqlClient.SqlClient, (sql) => sqlCredentialStore(sql, encryption))
    )

  static readonly memoryLayer: Layer.Layer<CredentialStore> = Layer.effect(
    CredentialStore,
    Effect.sync(() => {
      const values = new Map<string, string>()
      const claims = new Map<string, { readonly claim: string; readonly at: number }>()
      return {
        get: (key) => Effect.sync(() => Option.fromNullishOr(values.get(key))),
        set: (key, value) =>
          Effect.sync(() => {
            values.set(key, value)
            claims.delete(key)
          }),
        remove: (key) =>
          Effect.sync(() => {
            values.delete(key)
            claims.delete(key)
          }),
        claim: (key, claim, at) =>
          Effect.sync((): CredentialClaim => {
            if (!values.has(key)) return { _tag: "Missing" }
            const held = claims.get(key)
            if (held !== undefined) return { _tag: "Held", since: held.at }
            claims.set(key, { claim, at })
            return { _tag: "Claimed" }
          }),
        settleClaim: (key, claim, value) =>
          Effect.sync(() => {
            if (claims.get(key)?.claim !== claim) return false
            claims.delete(key)
            if (Option.isSome(value)) values.set(key, value.value)
            return true
          })
      }
    })
  )
}

const sqlCredentialStore = (sql: SqlClient.SqlClient, encryption: Encryption): CredentialStore["Service"] => {
  const failure =
    (action: string, key: CredentialKey) =>
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
             ON CONFLICT (key) DO UPDATE SET sealed = excluded.sealed, claim = NULL, claimed_at = NULL`,
            [key, sealed]
          )
        ),
        Effect.mapError(failure("store", key)),
        Effect.asVoid
      )
    ),

    remove: Effect.fn("CredentialStore.remove")((key: CredentialKey) =>
      sql
        .unsafe("DELETE FROM credential WHERE key = ?", [key])
        .pipe(Effect.mapError(failure("remove", key)), Effect.asVoid)
    ),

    claim: Effect.fn("CredentialStore.claim")(function* (key: CredentialKey, claim: string, at: number) {
      const claimed = yield* sql
        .unsafe(
          `UPDATE credential SET claim = ?, claimed_at = ?
         WHERE key = ? AND claim IS NULL
         RETURNING key`,
          [claim, at, key]
        )
        .pipe(Effect.mapError(failure("claim", key)))
      if (claimed.length === 1) return { _tag: "Claimed" } satisfies CredentialClaim
      const rows = yield* sql
        .unsafe("SELECT claimed_at FROM credential WHERE key = ?", [key])
        .pipe(Effect.flatMap(decodeClaimRows), Effect.mapError(failure("claim", key)))
      const row = rows[0]
      return row === undefined
        ? ({ _tag: "Missing" } satisfies CredentialClaim)
        : ({ _tag: "Held", since: row.claimed_at ?? at } satisfies CredentialClaim)
    }),

    settleClaim: Effect.fn("CredentialStore.settleClaim")(function* (
      key: CredentialKey,
      claim: string,
      value: Option.Option<string>
    ) {
      const sealed = Option.isSome(value)
        ? yield* Effect.try(() => encryption.seal(value.value)).pipe(Effect.mapError(failure("store", key)))
        : undefined
      const settled = yield* (
        sealed === undefined
          ? sql.unsafe(
              "UPDATE credential SET claim = NULL, claimed_at = NULL WHERE key = ? AND claim = ? RETURNING key",
              [key, claim]
            )
          : sql.unsafe(
              "UPDATE credential SET sealed = ?, claim = NULL, claimed_at = NULL WHERE key = ? AND claim = ? RETURNING key",
              [sealed, key, claim]
            )
      ).pipe(Effect.mapError(failure("settle claim on", key)))
      return settled.length === 1
    })
  }
}

export const readTokens = (
  store: CredentialStore["Service"],
  key: CredentialKey
): Effect.Effect<Option.Option<StoredTokens>, StorageError> =>
  store.get(key).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(Option.none<StoredTokens>()),
        onSome: (raw) =>
          Schema.decodeUnknownEffect(Schema.fromJsonString(StoredTokens))(raw).pipe(
            Effect.map(Option.some),
            Effect.mapError((cause) => new StorageError({ message: `Malformed stored tokens for ${key}`, cause }))
          )
      })
    )
  )

export const writeTokens = (
  store: CredentialStore["Service"],
  key: CredentialKey,
  tokens: StoredTokens
): Effect.Effect<void, StorageError> => store.set(key, JSON.stringify(tokens))
