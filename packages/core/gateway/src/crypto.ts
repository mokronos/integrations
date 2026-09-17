import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { randomBytes } from "node:crypto"
import path from "node:path"
import { decodeBase64UrlField } from "@integrations/contracts"
import { createEncryption } from "@integrations/integrations"
import type { Encryption } from "@integrations/integrations"

export { createEncryption }
export type { Encryption }

export interface EncryptionSource {
  readonly envValue?: string
  readonly keyFile?: string
}

/**
 * The master key a host runs with: the environment's if set, otherwise the
 * key file, minted on first use. Every payload at rest is sealed with it, so
 * a host without either cannot start.
 */
export const resolveEncryption = async (source: EncryptionSource): Promise<Encryption> => {
  if (source.envValue !== undefined && source.envValue.length > 0) {
    const key = decodeBase64UrlField("INTEGRATIONS_MASTER_KEY", source.envValue)
    if (key.length !== 32) {
      throw new Error(`INTEGRATIONS_MASTER_KEY must decode to 32 bytes, got ${key.length}`)
    }
    return createEncryption(key)
  }

  if (source.keyFile === undefined) {
    throw new Error("A master key is required: set INTEGRATIONS_MASTER_KEY or name a key file")
  }

  if (existsSync(source.keyFile)) {
    const key = readFileSync(source.keyFile)
    if (key.length !== 32) {
      throw new Error(`Key file ${source.keyFile} must be exactly 32 bytes`)
    }
    return createEncryption(key)
  }

  mkdirSync(path.dirname(source.keyFile), { recursive: true, mode: 0o700 })
  const key = randomBytes(32)
  writeFileSync(source.keyFile, key, { mode: 0o600 })
  chmodSync(source.keyFile, 0o600)
  return createEncryption(key)
}
