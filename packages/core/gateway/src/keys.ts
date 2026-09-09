import { createHash, randomUUID, randomBytes } from "node:crypto"
import { Encoding } from "effect"
import { utf8Bytes } from "@mokronos/contracts"
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

export interface IssuedApiKey {
  readonly id: ApiKeyId
  readonly secret: string
  readonly hash: ApiKeyHash
}

export const generateApiKey = (): IssuedApiKey => {
  const secret = `${keyPrefix}${Encoding.encodeBase64Url(randomBytes(32))}`
  return {
    id: ApiKeyId.make(randomUUID()),
    secret,
    hash: hashApiKey(secret)
  }
}

export const hashApiKey = (secret: string): ApiKeyHash =>
  ApiKeyHash.make(createHash("sha256").update(utf8Bytes(secret)).digest("hex"))

export interface IssuedLoginHandoff {
  readonly secret: string
  readonly hash: LoginHandoffHash
}

export const generateLoginHandoff = (): IssuedLoginHandoff => {
  const secret = `wfl_${Encoding.encodeBase64Url(randomBytes(32))}`
  return { secret, hash: hashLoginHandoff(secret) }
}

export const hashLoginHandoff = (secret: string): LoginHandoffHash =>
  LoginHandoffHash.make(createHash("sha256").update(utf8Bytes(secret)).digest("hex"))

export const newClientId = (): ClientId => ClientId.make(randomUUID())
export const newAccessProfileId = (): AccessProfileId => AccessProfileId.make(randomUUID())
export const newApprovalPolicyId = (): ApprovalPolicyId => ApprovalPolicyId.make(randomUUID())
export const newApprovalId = (): ApprovalId => ApprovalId.make(randomUUID())
export const newApprovalDestinationId = (): ApprovalDestinationId => ApprovalDestinationId.make(randomUUID())
export const newApprovalDeliveryId = (): ApprovalDeliveryId => ApprovalDeliveryId.make(randomUUID())
export const generateApprovalSigningSecret = (): string =>
  `wfs_${Encoding.encodeBase64Url(randomBytes(32))}`
export const newAuditId = (): AuditId => AuditId.make(randomUUID())
export const newTenantId = (): TenantId => TenantId.make(randomUUID())
export const newSubjectId = (): SubjectId => SubjectId.make(randomUUID())
