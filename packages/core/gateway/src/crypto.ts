import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes
} from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Encoding } from "effect"
import {
  concatBytes,
  decodeBase64Field,
  decodeBase64UrlField,
  utf8Text
} from "@mokronos/contracts"

const envelopePrefix = "enc.v1$"

export interface Encryption {
  readonly seal: (text: string) => string
  readonly open: (text: string) => string
  readonly lookup: (text: string) => string
}

const sealWith = (masterKey: Uint8Array) => (text: string): string => {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", masterKey, iv)
  const ciphertext = concatBytes([cipher.update(text, "utf8"), cipher.final()])
  const ivText = Encoding.encodeBase64(iv)
  const tagText = Encoding.encodeBase64(cipher.getAuthTag())
  const dataText = Encoding.encodeBase64(ciphertext)
  return `${envelopePrefix}${ivText}$${tagText}$${dataText}`
}

const openWith = (masterKey: Uint8Array) => (text: string): string => {
  if (!text.startsWith(envelopePrefix)) return text
  const [ivText, tagText, dataText] = text.slice(envelopePrefix.length).split("$")
  if (ivText === undefined || tagText === undefined || dataText === undefined) {
    throw new Error("Malformed encrypted value")
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    masterKey,
    decodeBase64Field("initialisation vector", ivText)
  )
  decipher.setAuthTag(decodeBase64Field("authentication tag", tagText))
  const plaintext = concatBytes([
    decipher.update(decodeBase64Field("ciphertext", dataText)),
    decipher.final()
  ])
  return utf8Text(plaintext)
}

const lookupWith = (masterKey: Uint8Array) => (text: string): string =>
  createHmac("sha256", masterKey).update(text).digest("hex")

export const createEncryption = (masterKey: Uint8Array): Encryption => ({
  seal: sealWith(masterKey),
  open: openWith(masterKey),
  lookup: lookupWith(masterKey)
})

export interface EncryptionSource {
  readonly envValue?: string
  readonly keyFile?: string
}

export const resolveEncryption = async (
  source: EncryptionSource
): Promise<Encryption | undefined> => {
  if (source.envValue !== undefined && source.envValue.length > 0) {
    const key = decodeBase64UrlField("INTEGRATIONS_MASTER_KEY", source.envValue)
    if (key.length !== 32) {
      throw new Error(
        `INTEGRATIONS_MASTER_KEY must decode to 32 bytes, got ${key.length}`
      )
    }
    return createEncryption(key)
  }

  if (source.keyFile !== undefined && existsSync(source.keyFile)) {
    const key = readFileSync(source.keyFile)
    if (key.length !== 32) {
      throw new Error(`Key file ${source.keyFile} must be exactly 32 bytes`)
    }
    return createEncryption(key)
  }

  if (source.keyFile !== undefined) {
    mkdirSync(path.dirname(source.keyFile), { recursive: true, mode: 0o700 })
    const key = randomBytes(32)
    writeFileSync(source.keyFile, key, { mode: 0o600 })
    chmodSync(source.keyFile, 0o600)
    return createEncryption(key)
  }

  return undefined
}
