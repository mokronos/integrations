import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto"
import { Effect, Schema } from "effect"
import { SessionTokenHash } from "./domain.ts"

export class PasswordError extends Schema.TaggedError<PasswordError>()(
  "PasswordError",
  { operation: Schema.String, cause: Schema.Defect() }
) {}

const scrypt = (password: string, salt: Buffer, keylen: number): Effect.Effect<Buffer, PasswordError> =>
  Effect.callback((resume) => {
    scryptCallback(password, salt, keylen, (error, derivedKey) => {
      if (derivedKey === undefined) {
        resume(Effect.fail(new PasswordError({
          operation: "scrypt",
          cause: error ?? new Error("scrypt failed")
        })))
      } else {
        resume(Effect.succeed(derivedKey))
      }
    })
  })

export const PasswordHash = Schema.String.check(Schema.isStartsWith("scrypt$"))
export type PasswordHash = typeof PasswordHash.Type

const keyLength = 64

export const hashPassword = Effect.fn("Password.hash")(function*(
  password: string
): Effect.fn.Return<PasswordHash, PasswordError> {
  const salt = yield* Effect.try({
    try: () => randomBytes(16),
    catch: (cause) => new PasswordError({ operation: "randomBytes", cause })
  })
  const derived = yield* scrypt(password, salt, keyLength)
  return PasswordHash.make(`scrypt$${salt.toString("base64")}$${derived.toString("base64")}`)
})

export const verifyPassword = Effect.fn("Password.verify")(function*(
  password: string,
  stored: PasswordHash
): Effect.fn.Return<boolean, PasswordError> {
  const [scheme, saltText, hashText] = stored.split("$")
  if (scheme !== "scrypt" || saltText === undefined || hashText === undefined) return false
  const expected = Buffer.from(hashText, "base64")
  const actual = yield* scrypt(password, Buffer.from(saltText, "base64"), expected.length)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
})

export interface IssuedSessionToken {
  readonly secret: string
  readonly hash: SessionTokenHash
}

export const generateSessionToken = (): IssuedSessionToken => {
  const secret = `wfs_${randomBytes(32).toString("base64url")}`
  return { secret, hash: hashSessionToken(secret) }
}

export const hashSessionToken = (secret: string): SessionTokenHash =>
  SessionTokenHash.make(createHash("sha256").update(secret, "utf8").digest("hex"))
