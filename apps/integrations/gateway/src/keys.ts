import { createHash, randomUUID, randomBytes } from "node:crypto"
import { ApiKeyHash, ApiKeyId, ApprovalId, AuditId, ClientId, GrantId } from "./domain.ts"

/** Keys are shown once and never stored. The prefix makes a leaked key
 *  greppable in logs and recognisable in a secret scanner. */
const keyPrefix = "wfi_"

export interface IssuedApiKey {
  readonly id: ApiKeyId
  /** Plaintext. Returned exactly once, at issue; nothing persists it. */
  readonly secret: string
  readonly hash: ApiKeyHash
}

/** 256 bits of entropy, so the stored SHA-256 needs no salt — there is no
 *  dictionary to attack, only the full keyspace. */
export const generateApiKey = (): IssuedApiKey => {
  const secret = `${keyPrefix}${randomBytes(32).toString("base64url")}`
  return {
    id: ApiKeyId.make(randomUUID()),
    secret,
    hash: hashApiKey(secret)
  }
}

export const hashApiKey = (secret: string): ApiKeyHash =>
  ApiKeyHash.make(createHash("sha256").update(secret, "utf8").digest("hex"))

export const newClientId = (): ClientId => ClientId.make(randomUUID())
export const newGrantId = (): GrantId => GrantId.make(randomUUID())
export const newApprovalId = (): ApprovalId => ApprovalId.make(randomUUID())
export const newAuditId = (): AuditId => AuditId.make(randomUUID())
