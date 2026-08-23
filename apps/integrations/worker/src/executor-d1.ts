import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto"
import type { CredentialProvider, ExecutorDbFactory, ProviderItemId } from "@executor-js/sdk/core"
import { ProviderKey, StorageError } from "@executor-js/sdk/core"
import {
  createDrizzleRuntimeSchemaFromTables,
  createDrizzleRuntimeSchemaSqlFromTables
} from "@executor-js/fumadb/adapters/drizzle"
import { createExecutorFumaDb } from "@executor-js/sdk/host-internal"
import type { ExecutorHostStorage } from "@mokronos/integrations-executor"
import { Effect, Schema } from "effect"
import { drizzle } from "drizzle-orm/d1"
import { sql } from "drizzle-orm"
import type { D1DatabaseLike } from "./cloudflare.ts"

/**
 * Executor storage on a Cloudflare D1 binding, replacing the file-backed
 * default (a JSON credential file plus a per-directory SQLite database).
 *
 * Sealing is byte-for-byte the file provider's scheme — AES-256-GCM with an
 * additional-data tag, envelope `v1.<iv>.<tag>.<ciphertext>` in base64url —
 * so values sealed locally stay readable after a move to D1.
 */

const executorNamespace = "wf_executor"
// Identical to the file provider's AAD: same format, different storage.
const credentialAdditionalData = Buffer.from("@mokronos/integrations/executor-credentials/v1")

/** Derives the 32-byte credential key from the gateway master key. There is
 *  no keyfile to mint on Workers, and a second secret to provision would be
 *  one more thing to lose: HMAC domain separation keeps this key distinct
 *  from every other use of INTEGRATIONS_MASTER_KEY while remaining fully
 *  determined by it. */
export const deriveCredentialKey = (masterKey: Buffer): Buffer =>
  createHmac("sha256", masterKey).update("executor-auth/v1").digest()

const sealCredential = (key: Buffer, value: string): string => {
  const initializationVector = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, initializationVector)
  cipher.setAAD(credentialAdditionalData)
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()])
  return [
    "v1",
    initializationVector.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url")
  ].join(".")
}

const openCredential = (key: Buffer, sealed: string): string => {
  const [version, encodedInitializationVector, encodedTag, encodedCiphertext, extra] =
    sealed.split(".")
  if (
    version !== "v1" ||
    encodedInitializationVector === undefined ||
    encodedTag === undefined ||
    encodedCiphertext === undefined ||
    extra !== undefined
  ) {
    throw new Error("Unsupported Executor credential format")
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(encodedInitializationVector, "base64url")
  )
  decipher.setAAD(credentialAdditionalData)
  decipher.setAuthTag(Buffer.from(encodedTag, "base64url"))
  return Buffer.concat([
    decipher.update(Buffer.from(encodedCiphertext, "base64url")),
    decipher.final()
  ]).toString("utf8")
}

const credentialTableDdl =
  `CREATE TABLE IF NOT EXISTS executor_credential (
     id TEXT PRIMARY KEY,
     sealed TEXT NOT NULL
   )`

const SealedRow = Schema.Struct({ sealed: Schema.String })
const decodeSealedRow = Schema.decodeUnknownSync(SealedRow)

export class D1CredentialProvider implements CredentialProvider {
  readonly key = ProviderKey.make("wf-d1")
  readonly writable = true
  readonly #database: D1DatabaseLike
  readonly #key: Buffer
  #ready: Promise<void> | undefined

  constructor(database: D1DatabaseLike, masterKey: Buffer) {
    this.#database = database
    this.#key = deriveCredentialKey(masterKey)
  }

  /** The table appears on first use rather than at construction, because the
   *  provider object exists before the Worker has a request to spend on I/O. */
  ensureReady(): Promise<void> {
    const ready = this.#ready ??= this.#database
      .prepare(credentialTableDdl)
      .run()
      .then(() => undefined)
    return ready
  }

  readonly get: (id: ProviderItemId) => Effect.Effect<string | null, StorageError> = (id) =>
    Effect.tryPromise({
      try: async () => {
        await this.ensureReady()
        const row = await this.#database
          .prepare("SELECT sealed FROM executor_credential WHERE id = ?")
          .bind(String(id))
          .first()
        if (row === null) return null
        return openCredential(this.#key, decodeSealedRow(row).sealed)
      },
      catch: (cause) => new StorageError({
        message: `Failed to load Executor credential ${String(id)} from D1`,
        cause
      })
    })

  readonly set: (id: ProviderItemId, value: string) => Effect.Effect<void, StorageError> = (
    id,
    value
  ) =>
    Effect.try({
      try: () => sealCredential(this.#key, value),
      catch: (cause) => new StorageError({
        message: `Failed to seal Executor credential ${String(id)}`,
        cause
      })
    }).pipe(
      Effect.flatMap((sealed) => Effect.tryPromise({
        try: async () => {
          await this.ensureReady()
          await this.#database
            .prepare(
              `INSERT INTO executor_credential (id, sealed) VALUES (?, ?)
                 ON CONFLICT (id) DO UPDATE SET sealed = excluded.sealed`
            )
            .bind(String(id), sealed)
            .run()
        },
        catch: (cause) => new StorageError({
          message: `Failed to store Executor credential ${String(id)} in D1`,
          cause
        })
      }))
    )

  readonly delete: (id: ProviderItemId) => Effect.Effect<void, StorageError> = (id) =>
    Effect.tryPromise({
      try: async () => {
        await this.ensureReady()
        await this.#database
          .prepare("DELETE FROM executor_credential WHERE id = ?")
          .bind(String(id))
          .run()
      },
      catch: (cause) => new StorageError({
        message: `Failed to remove Executor credential ${String(id)} from D1`,
        cause
      })
    })
}

/**
 * Builds the Executor's FumaDb over D1 instead of a per-directory SQLite
 * file. Two deliberate departures from the file path, both forced by D1:
 *
 * - Schema creation runs the generated DDL statement by statement. The shared
 *   helper wraps them in `db.transaction`, and drizzle's D1 driver implements
 *   that with a raw `BEGIN`, which D1 rejects.
 * - `interactiveTransactions: false` tells the FumaDB adapter that its
 *   transaction combinator may not use `BEGIN` either: bodies run
 *   sequentially without atomicity. The executor issues transactions rarely;
 *   a single-operator control plane accepts the narrower guarantee.
 */
export const d1ExecutorDatabase = (database: D1DatabaseLike): ExecutorDbFactory =>
  ({ tables }) => Effect.promise(async () => {
    const schema = createDrizzleRuntimeSchemaFromTables({
      tables,
      namespace: executorNamespace,
      version: "1.0.0",
      provider: "sqlite"
    })
    const drizzleDatabase = drizzle(database, { schema })
    for (const statement of createDrizzleRuntimeSchemaSqlFromTables({
      tables,
      namespace: executorNamespace,
      version: "1.0.0",
      provider: "sqlite"
    })) {
      await drizzleDatabase.run(sql.raw(statement))
    }
    const handle = createExecutorFumaDb(drizzleDatabase, {
      tables,
      namespace: executorNamespace,
      version: "1.0.0",
      provider: "sqlite",
      interactiveTransactions: false
    })
    return {
      db: handle.db,
      close: async () => undefined
    }
  })

/** The complete {@link ExecutorHostStorage} for a D1 deployment. */
export const d1ExecutorStorage = (
  database: D1DatabaseLike,
  masterKey: Buffer
): ExecutorHostStorage => ({
  providers: [new D1CredentialProvider(database, masterKey)],
  buildDatabase: d1ExecutorDatabase(database)
})
