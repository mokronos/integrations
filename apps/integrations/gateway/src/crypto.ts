import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes
} from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

/** Envelope prefix marking a value this module sealed. Reads accept both
 *  forms: rows written before encryption was enabled stay readable, so
 *  turning a key on is not a migration. */
const envelopePrefix = "enc.v1$"

export interface Encryption {
  /** Seals text into `enc.v1$<iv>$<tag>$<ciphertext>`. Randomised per call —
   *  equal inputs never produce equal ciphertexts. */
  readonly seal: (text: string) => string
  /** Opens a sealed value; passes anything without the envelope prefix through
   *  untouched, and throws on a value that claims to be sealed but fails
   *  authentication (wrong key or tampered ciphertext). */
  readonly open: (text: string) => string
  /** A deterministic keyed digest for equality lookups. The store needs to
   *  *find* the frozen call a retry belongs to, which randomised sealing
   *  forbids; the HMAC answers "is it this one?" without storing either the
   *  plaintext or a value an offline attacker can recompute. */
  readonly lookup: (text: string) => string
}

const sealWith = (masterKey: Buffer) => (text: string): string => {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", masterKey, iv)
  const ciphertext = Buffer.concat([cipher.update(text, "utf8"), cipher.final()])
  const ivText = iv.toString("base64")
  const tagText = cipher.getAuthTag().toString("base64")
  const dataText = ciphertext.toString("base64")
  return `${envelopePrefix}${ivText}$${tagText}$${dataText}`
}

const openWith = (masterKey: Buffer) => (text: string): string => {
  if (!text.startsWith(envelopePrefix)) return text
  const [ivText, tagText, dataText] = text.slice(envelopePrefix.length).split("$")
  if (ivText === undefined || tagText === undefined || dataText === undefined) {
    throw new Error("Malformed encrypted value")
  }
  const decipher = createDecipheriv("aes-256-gcm", masterKey, Buffer.from(ivText, "base64"))
  decipher.setAuthTag(Buffer.from(tagText, "base64"))
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(dataText, "base64")),
    decipher.final()
  ])
  return plaintext.toString("utf8")
}

const lookupWith = (masterKey: Buffer) => (text: string): string =>
  createHmac("sha256", masterKey).update(text).digest("hex")

export const createEncryption = (masterKey: Buffer): Encryption => ({
  seal: sealWith(masterKey),
  open: openWith(masterKey),
  lookup: lookupWith(masterKey)
})

export interface EncryptionSource {
  /** Base64url of 32 bytes, from INTEGRATIONS_MASTER_KEY. */
  readonly envValue?: string
  /** A keyfile inside the gateway's home directory, created on first use with
   *  owner-only permissions when no environment key is given. */
  readonly keyFile?: string
}

/** Decides where the master key comes from: the environment wins, then an
 *  existing keyfile, then nothing — an unconfigured gateway stores plaintext,
 *  exactly as it always has.
 *
 * Generating the keyfile here rather than asking every operator to mint one
 * keeps the local-to-hosted path zero-configuration; writing it with 0600
 * means a leaked database file alone still yields no keys. */
export const resolveEncryption = async (
  source: EncryptionSource
): Promise<Encryption | undefined> => {
  if (source.envValue !== undefined && source.envValue.length > 0) {
    const key = Buffer.from(source.envValue, "base64url")
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
    // writeFileSync applies the mode only at creation; reassert it so an
    // unexpected umask cannot leave the key world-readable.
    chmodSync(source.keyFile, 0o600)
    return createEncryption(key)
  }

  return undefined
}
