import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto"
import { Schema } from "effect"
import { SessionTokenHash } from "./domain.ts"

/** Promise wrapper over node's callback-style scrypt, typed locally so no cast
 *  is needed anywhere in this module. */
const scrypt = (password: string, salt: Buffer, keylen: number): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, (error, derivedKey) => {
      // Node signals failure with `null`, Bun with `undefined`; the key's
      // presence decides, which holds under both.
      if (derivedKey === undefined) {
        reject(error ?? new Error("scrypt failed"))
      } else {
        resolve(derivedKey)
      }
    })
  })

/** Password hashes are stored in the form this module verifies, so the cost
 *  parameters can move without invalidating stored logins. */
export const PasswordHash = Schema.String.pipe(
  Schema.refine((value): value is string => value.startsWith("scrypt$"))
)
export type PasswordHash = typeof PasswordHash.Type

const keyLength = 64

/** scrypt with a per-password salt. Deliberately memory-hard: a leaked login
 *  table must not be cheap to brute-force offline. */
export const hashPassword = async (password: string): Promise<PasswordHash> => {
  const salt = randomBytes(16)
  const derived = await scrypt(password, salt, keyLength)
  return PasswordHash.make(`scrypt$${salt.toString("base64")}$${derived.toString("base64")}`)
}

export const verifyPassword = async (password: string, stored: PasswordHash): Promise<boolean> => {
  const [scheme, saltText, hashText] = stored.split("$")
  if (scheme !== "scrypt" || saltText === undefined || hashText === undefined) return false
  const expected = Buffer.from(hashText, "base64")
  const actual = await scrypt(password, Buffer.from(saltText, "base64"), expected.length)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

/** Sessions are bearer tokens like API keys: shown once, stored only as a
 *  SHA-256, and recognisable in a secret scanner by their prefix. */
export interface IssuedSessionToken {
  /** Plaintext. Lives only in the human's cookie. */
  readonly secret: string
  readonly hash: SessionTokenHash
}

export const generateSessionToken = (): IssuedSessionToken => {
  const secret = `wfs_${randomBytes(32).toString("base64url")}`
  return { secret, hash: hashSessionToken(secret) }
}

export const hashSessionToken = (secret: string): SessionTokenHash =>
  SessionTokenHash.make(createHash("sha256").update(secret, "utf8").digest("hex"))
