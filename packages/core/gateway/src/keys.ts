import { Crypto, Effect, Encoding } from "effect"
import { utf8Bytes } from "@integrations/contracts"
import {
  ApiKeyHash,
  ApiKeyId,
  ApprovalId,
  ApprovalDeliveryId,
  ApprovalDestinationId,
  AuditId,
  ClientId,
  AccessProfileId,
  ApprovalPolicyId,
  LoginHandoffHash,
  SubjectId,
  TenantId
} from "./domain.ts"

const keyPrefix = "wfi_"

/** Bytes of entropy behind every secret we mint. */
const secretBytes = 32

/**
 * The platform's random and digest primitives fail only on an out-of-range
 * size, which every caller here supplies as a constant. A failure would be a
 * bug in this file rather than a condition callers can act on, so it is a
 * defect and the identifiers keep a clean error channel.
 */
const randomBytes = (size: number): Effect.Effect<Uint8Array, never, Crypto.Crypto> =>
  Effect.flatMap(Crypto.Crypto, (crypto) => Effect.orDie(crypto.randomBytes(size)))

const uuid: Effect.Effect<string, never, Crypto.Crypto> = Effect.flatMap(
  Crypto.Crypto,
  (crypto) => Effect.orDie(crypto.randomUUIDv4)
)

export const sha256Hex = (text: string): Effect.Effect<string, never, Crypto.Crypto> =>
  Effect.flatMap(Crypto.Crypto, (crypto) =>
    Effect.orDie(crypto.digest("SHA-256", utf8Bytes(text)))
  ).pipe(Effect.map(Encoding.encodeHex))

const prefixedSecret = (prefix: string): Effect.Effect<string, never, Crypto.Crypto> =>
  Effect.map(randomBytes(secretBytes), (bytes) => `${prefix}${Encoding.encodeBase64Url(bytes)}`)

export interface IssuedApiKey {
  readonly id: ApiKeyId
  readonly secret: string
  readonly hash: ApiKeyHash
}

export const generateApiKey: Effect.Effect<IssuedApiKey, never, Crypto.Crypto> = Effect.gen(
  function*() {
    const secret = yield* prefixedSecret(keyPrefix)
    return {
      id: ApiKeyId.make(yield* uuid),
      secret,
      hash: yield* hashApiKey(secret)
    }
  }
)

export const hashApiKey = (secret: string): Effect.Effect<ApiKeyHash, never, Crypto.Crypto> =>
  Effect.map(sha256Hex(secret), ApiKeyHash.make)

export interface IssuedLoginHandoff {
  readonly secret: string
  readonly hash: LoginHandoffHash
}

export const generateLoginHandoff: Effect.Effect<IssuedLoginHandoff, never, Crypto.Crypto> = Effect
  .gen(function*() {
    const secret = yield* prefixedSecret("wfl_")
    return { secret, hash: yield* hashLoginHandoff(secret) }
  })

export const hashLoginHandoff = (
  secret: string
): Effect.Effect<LoginHandoffHash, never, Crypto.Crypto> =>
  Effect.map(sha256Hex(secret), LoginHandoffHash.make)

export const generateApprovalSigningSecret: Effect.Effect<string, never, Crypto.Crypto> =
  prefixedSecret("wfs_")

/** Session tokens carry the same prefix and entropy as approval secrets. */
export const sessionSecret: Effect.Effect<string, never, Crypto.Crypto> = prefixedSecret("wfs_")

export const newClientId: Effect.Effect<ClientId, never, Crypto.Crypto> = Effect.map(
  uuid,
  ClientId.make
)
export const newAccessProfileId: Effect.Effect<AccessProfileId, never, Crypto.Crypto> = Effect.map(
  uuid,
  AccessProfileId.make
)
export const newApprovalPolicyId: Effect.Effect<ApprovalPolicyId, never, Crypto.Crypto> = Effect
  .map(uuid, ApprovalPolicyId.make)
export const newApprovalId: Effect.Effect<ApprovalId, never, Crypto.Crypto> = Effect.map(
  uuid,
  ApprovalId.make
)
export const newApprovalDestinationId: Effect.Effect<
  ApprovalDestinationId,
  never,
  Crypto.Crypto
> = Effect.map(uuid, ApprovalDestinationId.make)
export const newApprovalDeliveryId: Effect.Effect<ApprovalDeliveryId, never, Crypto.Crypto> = Effect
  .map(uuid, ApprovalDeliveryId.make)
export const newAuditId: Effect.Effect<AuditId, never, Crypto.Crypto> = Effect.map(
  uuid,
  AuditId.make
)
export const newTenantId: Effect.Effect<TenantId, never, Crypto.Crypto> = Effect.map(
  uuid,
  TenantId.make
)
export const newSubjectId: Effect.Effect<SubjectId, never, Crypto.Crypto> = Effect.map(
  uuid,
  SubjectId.make
)
