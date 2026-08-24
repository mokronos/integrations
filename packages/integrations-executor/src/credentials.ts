import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs"
import path from "node:path"
import { Context, Effect, Layer, Option, Schema, Semaphore } from "effect"
import { describeCause, StorageError } from "./errors.ts"

/** Where every secret the host holds actually lives.
 *
 *  Nothing else in the host stores a credential: the catalog database keeps
 *  references (which client, which template, which scopes) and this store keeps
 *  the values, sealed. Splitting them is what makes a database dump safe to
 *  read and lets the same catalog run against a different secret backend. */

/** The address a secret is filed under — a connection address for a token, or
 *  `oauth-client:<owner>:<slug>` for a registered client's secret. */
export const CredentialKey = Schema.String.pipe(
  Schema.refine((value): value is string => value.length > 0),
  Schema.brand("CredentialKey")
)
export type CredentialKey = typeof CredentialKey.Type

export const connectionCredentialKey = (address: string): CredentialKey =>
  CredentialKey.make(`connection:${address}`)

export const oauthClientCredentialKey = (
  owner: string,
  slug: string
): CredentialKey => CredentialKey.make(`oauth-client:${owner}:${slug}`)

/** A stored OAuth grant. Kept as one sealed JSON value so a refresh replaces
 *  access token, refresh token, and expiry atomically. */
export const StoredTokens = Schema.Struct({
  accessToken: Schema.String,
  tokenType: Schema.optional(Schema.String),
  refreshToken: Schema.optional(Schema.String),
  /** Epoch milliseconds. Absent means the provider issued no expiry. */
  expiresAt: Schema.optional(Schema.Number),
  scope: Schema.optional(Schema.String)
})
export type StoredTokens = typeof StoredTokens.Type

export class CredentialStore extends Context.Service<
  CredentialStore,
  {
    readonly get: (key: CredentialKey) => Effect.Effect<Option.Option<string>, StorageError>
    readonly set: (key: CredentialKey, value: string) => Effect.Effect<void, StorageError>
    readonly remove: (key: CredentialKey) => Effect.Effect<void, StorageError>
  }
>()("@mokronos/integrations-executor/CredentialStore") {
  static readonly fileLayer = (directory: string): Layer.Layer<CredentialStore> =>
    Layer.effect(CredentialStore, Effect.sync(() => fileCredentialStore(directory)))

  /** Unsealed, process-local. For tests and for probing an endpoint before any
   *  connection exists. */
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

const CredentialFile = Schema.Record(Schema.String, Schema.String)
type CredentialFile = typeof CredentialFile.Type

const additionalData = Buffer.from("@mokronos/integrations/credentials/v1")

/** Mints the file key on first use. Written with `wx` so two processes racing
 *  to create it cannot each install a different key. */
const credentialKey = (directory: string): Buffer => {
  const keyPath = path.join(directory, "credentials.key")
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  if (!existsSync(keyPath)) {
    try {
      writeFileSync(keyPath, randomBytes(32), { flag: "wx", mode: 0o600 })
    } catch (cause) {
      if (!(cause instanceof Error) || !("code" in cause) || cause.code !== "EEXIST") {
        throw cause
      }
    }
  }
  chmodSync(keyPath, 0o600)
  const key = readFileSync(keyPath)
  if (key.byteLength !== 32) throw new Error(`Invalid credential key at ${keyPath}`)
  return key
}

export const sealValue = (key: Buffer, value: string): string => {
  const initializationVector = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, initializationVector)
  cipher.setAAD(additionalData)
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()])
  return [
    "v1",
    initializationVector.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url")
  ].join(".")
}

export const openValue = (key: Buffer, sealed: string): string => {
  const [version, encodedVector, encodedTag, encodedCiphertext, extra] = sealed.split(".")
  if (
    version !== "v1" ||
    encodedVector === undefined ||
    encodedTag === undefined ||
    encodedCiphertext === undefined ||
    extra !== undefined
  ) {
    throw new Error("Unsupported credential envelope")
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(encodedVector, "base64url")
  )
  decipher.setAAD(additionalData)
  decipher.setAuthTag(Buffer.from(encodedTag, "base64url"))
  return Buffer.concat([
    decipher.update(Buffer.from(encodedCiphertext, "base64url")),
    decipher.final()
  ]).toString("utf8")
}

const fileCredentialStore = (directory: string): CredentialStore["Service"] => {
  const filePath = path.join(directory, "credentials.json")
  // One writer at a time: every mutation is read-modify-write of the whole
  // file, so concurrent sets would otherwise drop each other's entries.
  const writes = Semaphore.makeUnsafe(1)

  const readAll = Effect.try({
    try: (): CredentialFile => {
      if (!existsSync(filePath)) return {}
      return Schema.decodeUnknownSync(Schema.fromJsonString(CredentialFile))(
        readFileSync(filePath, "utf8")
      )
    },
    catch: (cause) => new StorageError({
      message: `Could not read credentials from ${filePath}: ${describeCause(cause)}`,
      cause
    })
  })

  const writeAll = (credentials: CredentialFile) => Effect.try({
    try: () => {
      mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
      const temporaryPath = `${filePath}.${process.pid}.tmp`
      writeFileSync(temporaryPath, JSON.stringify(credentials, null, 2), { mode: 0o600 })
      chmodSync(temporaryPath, 0o600)
      renameSync(temporaryPath, filePath)
    },
    catch: (cause) => new StorageError({
      message: `Could not write credentials to ${filePath}: ${describeCause(cause)}`,
      cause
    })
  })

  return {
    get: Effect.fn("CredentialStore.get")(function* (key: CredentialKey) {
      const credentials = yield* readAll
      const sealed = credentials[key]
      if (sealed === undefined) return Option.none()
      return Option.some(yield* Effect.try({
        try: () => openValue(credentialKey(directory), sealed),
        catch: (cause) => new StorageError({
          message: `Could not open credential ${key}: ${describeCause(cause)}`,
          cause
        })
      }))
    }),

    set: Effect.fn("CredentialStore.set")((key: CredentialKey, value: string) =>
      writes.withPermit(Effect.gen(function* () {
        const sealed = yield* Effect.try({
          try: () => sealValue(credentialKey(directory), value),
          catch: (cause) => new StorageError({
            message: `Could not seal credential ${key}: ${describeCause(cause)}`,
            cause
          })
        })
        const credentials = yield* readAll
        yield* writeAll({ ...credentials, [key]: sealed })
      }))
    ),

    remove: Effect.fn("CredentialStore.remove")((key: CredentialKey) =>
      writes.withPermit(Effect.gen(function* () {
        const credentials = yield* readAll
        yield* writeAll(
          Object.fromEntries(Object.entries(credentials).filter(([name]) => name !== key))
        )
      }))
    )
  }
}

/** Reads a connection's stored OAuth grant, if it has one. */
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
