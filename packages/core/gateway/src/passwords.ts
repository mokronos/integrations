import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto"
import { Crypto, Effect, Encoding, Schema } from "effect"
import { decodeBase64Field } from "@mokronos/contracts"
import { sessionSecret, sha256Hex } from "./keys.ts"
import { SessionTokenHash } from "./domain.ts"

export class PasswordError extends Schema.TaggedError<PasswordError>()(
  "PasswordError",
  { operation: Schema.String, cause: Schema.Defect() }
) {}

const scrypt = (password: string, salt: Uint8Array, keylen: number): Effect.Effect<Buffer, PasswordError> =>
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
  return PasswordHash.make(
    `scrypt$${Encoding.encodeBase64(salt)}$${Encoding.encodeBase64(derived)}`
  )
})

export const verifyPassword = Effect.fn("Password.verify")(function*(
  password: string,
  stored: PasswordHash
): Effect.fn.Return<boolean, PasswordError> {
  const [scheme, saltText, hashText] = stored.split("$")
  if (scheme !== "scrypt" || saltText === undefined || hashText === undefined) return false
  const expected = decodeBase64Field("stored password hash", hashText)
  const actual = yield* scrypt(
    password,
    decodeBase64Field("stored password salt", saltText),
    expected.length
  )
  return expected.length === actual.length && timingSafeEqual(expected, actual)
})

export interface IssuedSessionToken {
  readonly secret: string
  readonly hash: SessionTokenHash
}

export const generateSessionToken: Effect.Effect<
  IssuedSessionToken,
  never,
  Crypto.Crypto
> = Effect.gen(function*() {
  const secret = yield* sessionSecret
  return { secret, hash: yield* hashSessionToken(secret) }
})

export const hashSessionToken = (
  secret: string
): Effect.Effect<SessionTokenHash, never, Crypto.Crypto> =>
  Effect.map(sha256Hex(secret), SessionTokenHash.make)
