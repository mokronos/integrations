import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs"
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import path from "node:path"
import { createClient } from "@libsql/client"
import {
  createDrizzleRuntimeSchemaFromTables,
  ensureDrizzleRuntimeSchemaFromTables
} from "@executor-js/fumadb/adapters/drizzle"
import { mcpPlugin } from "@executor-js/plugin-mcp/core"
import { openApiPlugin } from "@executor-js/plugin-openapi/core"
import {
  createExecutor,
  type CredentialProvider,
  type Executor,
  ProviderKey,
  type ProviderItemId,
  StorageError,
  Tenant
} from "@executor-js/sdk/core"
import { createExecutorFumaDb } from "@executor-js/sdk/host-internal"
import { drizzle } from "drizzle-orm/libsql"
import { Effect, Schema } from "effect"

const plugins = [
  mcpPlugin({ dangerouslyAllowStdioMCP: false }),
  openApiPlugin()
] as const

export type WfExecutor = Executor<typeof plugins>

const defaultStorageDirectory = (): string =>
  process.env["WF_STORAGE_DIR"] ?? path.join(process.cwd(), ".wf")

let configuredStorageDirectory: string | undefined
const executors = new Map<string, Promise<WfExecutor>>()
const CredentialFile = Schema.Record(Schema.String, Schema.String)
const credentialAdditionalData = Buffer.from("@mokronos/wfkit/executor-credentials/v1")

const credentialKey = (directory: string): Buffer => {
  const keyPath = path.join(directory, "executor-auth.key")
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
  if (key.byteLength !== 32) throw new Error(`Invalid Executor credential key at ${keyPath}`)
  return key
}

const sealCredential = (directory: string, value: string): string => {
  const initializationVector = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", credentialKey(directory), initializationVector)
  cipher.setAAD(credentialAdditionalData)
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()])
  return [
    "v1",
    initializationVector.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url")
  ].join(".")
}

const openCredential = (directory: string, sealed: string): string => {
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
    credentialKey(directory),
    Buffer.from(encodedInitializationVector, "base64url")
  )
  decipher.setAAD(credentialAdditionalData)
  decipher.setAuthTag(Buffer.from(encodedTag, "base64url"))
  return Buffer.concat([
    decipher.update(Buffer.from(encodedCiphertext, "base64url")),
    decipher.final()
  ]).toString("utf8")
}

const readCredentials = (filePath: string) => Effect.try({
  try: () => {
    if (!existsSync(filePath)) return {}
    return Schema.decodeUnknownSync(Schema.fromJsonString(CredentialFile))(
      readFileSync(filePath, "utf8")
    )
  },
  catch: (cause) => new StorageError({
    message: `Failed to read Executor credentials from ${filePath}`,
    cause
  })
})

const writeCredentials = (
  filePath: string,
  credentials: typeof CredentialFile.Type
) => Effect.try({
  try: () => {
    mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
    const temporaryPath = `${filePath}.${process.pid}.tmp`
    writeFileSync(temporaryPath, JSON.stringify(credentials, null, 2), { mode: 0o600 })
    chmodSync(temporaryPath, 0o600)
    renameSync(temporaryPath, filePath)
  },
  catch: (cause) => new StorageError({
    message: `Failed to write Executor credentials to ${filePath}`,
    cause
  })
})

const fileCredentialProvider = (directory: string): CredentialProvider => {
  const filePath = path.join(directory, "executor-auth.json")
  return {
    key: ProviderKey.make("wf-file"),
    writable: true,
    get: (id: ProviderItemId) =>
      readCredentials(filePath).pipe(
        Effect.flatMap((credentials) => {
          const sealed = credentials[String(id)]
          if (sealed === undefined) return Effect.succeed(null)
          return Effect.try({
            try: () => openCredential(directory, sealed),
            catch: (cause) => new StorageError({
              message: `Failed to open Executor credential ${String(id)}`,
              cause
            })
          })
        })
      ),
    set: (id: ProviderItemId, value: string) =>
      Effect.try({
        try: () => sealCredential(directory, value),
        catch: (cause) => new StorageError({
          message: `Failed to seal Executor credential ${String(id)}`,
          cause
        })
      }).pipe(
        Effect.flatMap((sealed) =>
          readCredentials(filePath).pipe(
            Effect.flatMap((credentials) =>
              writeCredentials(filePath, { ...credentials, [String(id)]: sealed })
            )
          )
        )
      ),
    delete: (id: ProviderItemId) =>
      readCredentials(filePath).pipe(
        Effect.flatMap((credentials) => {
          const next = Object.fromEntries(
            Object.entries(credentials).filter(([key]) => key !== String(id))
          )
          return writeCredentials(filePath, next)
        })
      )
  }
}

export const setExecutorStorageDirectory = (directory: string): void => {
  configuredStorageDirectory = path.resolve(directory)
}

export const executorStorageDirectory = (): string =>
  configuredStorageDirectory ?? path.resolve(defaultStorageDirectory())

const makeExecutor = async (directory: string): Promise<WfExecutor> => {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  return await Effect.runPromise(createExecutor({
    tenant: Tenant.make("wf-local"),
    plugins,
    providers: [fileCredentialProvider(directory)],
    onElicitation: "accept-all",
    db: ({ tables }) => Effect.promise(async () => {
      const databasePath = path.join(directory, "executor.sqlite")
      const client = createClient({ url: `file:${databasePath}` })
      await client.execute("PRAGMA foreign_keys = ON")
      await client.execute("PRAGMA journal_mode = WAL")
      const schema = createDrizzleRuntimeSchemaFromTables({
        tables,
        namespace: "wf_executor",
        version: "1.0.0",
        provider: "sqlite"
      })
      const drizzleDatabase = drizzle({ client, schema })
      await ensureDrizzleRuntimeSchemaFromTables(drizzleDatabase, {
        tables,
        namespace: "wf_executor",
        version: "1.0.0",
        provider: "sqlite"
      })
      const handle = createExecutorFumaDb(drizzleDatabase, {
        tables,
        namespace: "wf_executor",
        version: "1.0.0",
        provider: "sqlite"
      })
      return {
        db: handle.db,
        close: async () => client.close()
      }
    })
  }))
}

export const getExecutor = (): Promise<WfExecutor> => {
  const directory = executorStorageDirectory()
  const existing = executors.get(directory)
  if (existing !== undefined) return existing
  const created = makeExecutor(directory)
  executors.set(directory, created)
  return created
}

export const closeExecutor = async (directory?: string): Promise<void> => {
  const resolved = path.resolve(directory ?? executorStorageDirectory())
  const executor = executors.get(resolved)
  if (executor === undefined) return
  executors.delete(resolved)
  await Effect.runPromise((await executor).close())
}

export const runExecutor = async <A, E>(
  operation: (executor: WfExecutor) => Effect.Effect<A, E>
): Promise<A> =>
  await Effect.runPromise(operation(await getExecutor()))
