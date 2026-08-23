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
import {
  type CredentialProvider,
  ProviderKey,
  type ProviderItemId,
  StorageError
} from "@executor-js/sdk/core"
import { Effect, Schema, Semaphore } from "effect"

const CredentialFile = Schema.Record(Schema.String, Schema.String)
const credentialAdditionalData = Buffer.from("@mokronos/integrations/executor-credentials/v1")

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

export const fileCredentialProvider = (directory: string): CredentialProvider => {
  const filePath = path.join(directory, "executor-auth.json")
  const writes = Semaphore.makeUnsafe(1)
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
      writes.withPermit(Effect.try({
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
      )),
    delete: (id: ProviderItemId) =>
      writes.withPermit(readCredentials(filePath).pipe(
        Effect.flatMap((credentials) => {
          const next = Object.fromEntries(
            Object.entries(credentials).filter(([key]) => key !== String(id))
          )
          return writeCredentials(filePath, next)
        })
      ))
  }
}
