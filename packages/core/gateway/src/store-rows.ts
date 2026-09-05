import { ApprovalStatus } from "./domain.ts"
import type { Row } from "@libsql/client"
import { Schema } from "effect"
import {
  AccessProfileId, Alias, ApiKeyHash, ApiKeyId, ApprovalDelivery, ApprovalDeliveryId,
  ApprovalDestinationId, ApprovalId,
  ApprovalPolicyId, AuditId, ClientId, ConnectionName, IntegrationSlug,
  LoginHandoffHash, SessionTokenHash, SubjectId, TenantId, ToolName
} from "./domain.ts"
import type {
  AccessProfile, AccessProfileTool, ApiKey, ApprovalDeliveryAttempt, ApprovalDestination, ApprovalPolicy, ApprovalPolicyTool,
  AuditRecord, AuthSession, Client, ConnectionRef, ExternalIdentity, LoginHandoff,
  PendingApproval, Subject, Tenant, ToolSnapshot
} from "./domain.ts"
import { PasswordHash } from "./passwords.ts"
import type { IdentityOAuthStateRecord, LoginRecord } from "./store-contract.ts"

// --- row decoding -----------------------------------------------------------
// libsql rows carry numeric indices and a length alongside the named columns,
// so fields are picked explicitly rather than spread.

const pick = (row: Row, keys: ReadonlyArray<string>): Record<string, Row[string]> =>
  Object.fromEntries(keys.map((key) => [key, row[key] ?? null]))

const NullableNumber = Schema.NullOr(Schema.Number)
const NullableString = Schema.NullOr(Schema.String)

const ClientRow = Schema.Struct({
  id: Schema.String,
  tenant_id: Schema.String,
  access_profile_id: Schema.String,
  approval_policy_id: Schema.String,
  name: Schema.String,
  capabilities: Schema.String,
  approval_delivery: Schema.String,
  created_at: Schema.Number,
  revoked_at: NullableNumber
})

const TenantRow = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  created_at: Schema.Number
})

const SubjectRow = Schema.Struct({
  id: Schema.String,
  tenant_id: Schema.String,
  created_at: Schema.Number
})

const LoginRow = Schema.Struct({
  subject_id: Schema.String,
  tenant_id: Schema.String,
  email: Schema.String,
  password_hash: NullableString,
  created_at: Schema.Number
})

const SessionRow = Schema.Struct({
  token_hash: Schema.String,
  subject_id: Schema.String,
  tenant_id: Schema.String,
  created_at: Schema.Number,
  expires_at: Schema.Number
})

const ExternalIdentityRow = Schema.Struct({
  provider: Schema.Literal("google"),
  provider_subject: Schema.String,
  subject_id: Schema.String,
  tenant_id: Schema.String,
  email: Schema.String,
  created_at: Schema.Number
})

const LoginHandoffRow = Schema.Struct({
  request_hash: Schema.String,
  subject_id: NullableString,
  tenant_id: NullableString,
  email: NullableString,
  created_at: Schema.Number,
  expires_at: Schema.Number,
  collected_at: NullableNumber
})

const IdentityOAuthStateRow = Schema.Struct({
  state_hash: Schema.String,
  provider: Schema.Literal("google"),
  handoff_hash: NullableString,
  return_path: NullableString,
  expires_at: Schema.Number
})

const ApiKeyRow = Schema.Struct({
  id: Schema.String,
  client_id: Schema.String,
  hash: Schema.String,
  created_at: Schema.Number,
  last_used_at: NullableNumber,
  revoked_at: NullableNumber
})

const ConfigurationRow = Schema.Struct({
  id: Schema.String,
  tenant_id: Schema.String,
  name: Schema.String,
  is_default: Schema.Number,
  created_at: Schema.Number,
  updated_at: Schema.Number
})

const AccessProfileToolRow = Schema.Struct({
  access_profile_id: Schema.String,
  owner: Schema.Literals(["org", "user"]),
  subject: NullableString,
  integration: Schema.String,
  connection_name: Schema.String,
  tool: Schema.String
})

const ApprovalPolicyToolRow = Schema.Struct({
  approval_policy_id: Schema.String,
  owner: Schema.Literals(["org", "user"]),
  subject: NullableString,
  integration: Schema.String,
  connection_name: Schema.String,
  tool: Schema.String,
  decision: Schema.Literals(["allow", "require_approval"])
})

const ApprovalRow = Schema.Struct({
  id: Schema.String,
  client_id: Schema.String,
  approval_policy_id: Schema.String,
  access_profile_id: Schema.String,
  alias: Schema.String,
  tool: Schema.String,
  arguments: Schema.String,
  status: ApprovalStatus,
  created_at: Schema.Number,
  expires_at: Schema.Number,
  decided_at: NullableNumber,
  decided_by: NullableString,
  result: NullableString,
  error: NullableString,
  collected_at: NullableNumber
})

const ApprovalDestinationRow = Schema.Struct({
  id: Schema.String,
  tenant_id: Schema.String,
  name: Schema.String,
  type: Schema.Literal("webhook"),
  url: Schema.String,
  created_at: Schema.Number
})

const ApprovalDeliveryRow = Schema.Struct({
  id: Schema.String,
  approval_id: Schema.String,
  destination_id: Schema.String,
  destination_name: Schema.String,
  status: Schema.Literals(["pending", "retrying", "delivered", "failed"]),
  attempts: Schema.Number,
  next_attempt_at: NullableNumber,
  delivered_at: NullableNumber,
  last_error: NullableString
})

const AuditRow = Schema.Struct({
  id: Schema.String,
  client_id: NullableString,
  alias: NullableString,
  tool: NullableString,
  owner: Schema.NullOr(Schema.Literals(["org", "user"])),
  subject: NullableString,
  integration: NullableString,
  connection_name: NullableString,
  decision: Schema.NullOr(Schema.Literals(["allow", "require_approval"])),
  outcome: Schema.Literals(["succeeded", "failed", "denied", "pending"]),
  message: NullableString,
  created_at: Schema.Number
})

const SnapshotRow = Schema.Struct({
  integration: Schema.String,
  connection_name: Schema.String,
  tool: Schema.String,
  input_schema: NullableString,
  output_schema: NullableString,
  synced_at: Schema.Number
})

const clientColumns = [
  "id", "tenant_id", "access_profile_id", "approval_policy_id", "name", "capabilities", "approval_delivery", "created_at", "revoked_at"
]
const tenantColumns = ["id", "name", "created_at"]
const subjectColumns = ["id", "tenant_id", "created_at"]
const loginColumns = ["subject_id", "tenant_id", "email", "password_hash", "created_at"]
const sessionColumns = ["token_hash", "subject_id", "tenant_id", "created_at", "expires_at"]
const externalIdentityColumns = [
  "provider", "provider_subject", "subject_id", "tenant_id", "email", "created_at"
]
const loginHandoffColumns = [
  "request_hash", "subject_id", "tenant_id", "email", "created_at", "expires_at", "collected_at"
]
const identityOAuthStateColumns = [
  "state_hash", "provider", "handoff_hash", "return_path", "expires_at"
]
const apiKeyColumns = ["id", "client_id", "hash", "created_at", "last_used_at", "revoked_at"]
const configurationColumns = [
  "id", "tenant_id", "name", "is_default", "created_at", "updated_at"
]
const accessProfileToolColumns = [
  "access_profile_id", "owner", "subject", "integration", "connection_name", "tool"
]
const approvalPolicyToolColumns = [
  "approval_policy_id", "owner", "subject", "integration", "connection_name", "tool", "decision"
]
const approvalColumns = [
  "id", "client_id", "approval_policy_id", "access_profile_id", "alias", "tool", "arguments", "status",
  "created_at", "expires_at", "decided_at", "decided_by", "result", "error", "collected_at"
]
const auditColumns = [
  "id", "client_id", "alias", "tool", "owner", "subject", "integration",
  "connection_name", "decision", "outcome", "message", "created_at"
]
const snapshotColumns = [
  "integration", "connection_name", "tool", "input_schema", "output_schema", "synced_at"
]

const decodeClientRow = Schema.decodeUnknownSync(ClientRow)
const decodeTenantRow = Schema.decodeUnknownSync(TenantRow)
const decodeSubjectRow = Schema.decodeUnknownSync(SubjectRow)
const decodeLoginRow = Schema.decodeUnknownSync(LoginRow)
const decodeSessionRow = Schema.decodeUnknownSync(SessionRow)
const decodeExternalIdentityRow = Schema.decodeUnknownSync(ExternalIdentityRow)
const decodeLoginHandoffRow = Schema.decodeUnknownSync(LoginHandoffRow)
const decodeIdentityOAuthStateRow = Schema.decodeUnknownSync(IdentityOAuthStateRow)
const decodeApiKeyRow = Schema.decodeUnknownSync(ApiKeyRow)
const decodeConfigurationRow = Schema.decodeUnknownSync(ConfigurationRow)
const decodeAccessProfileToolRow = Schema.decodeUnknownSync(AccessProfileToolRow)
const decodeApprovalPolicyToolRow = Schema.decodeUnknownSync(ApprovalPolicyToolRow)
const decodeApprovalRow = Schema.decodeUnknownSync(ApprovalRow)
const decodeAuditRow = Schema.decodeUnknownSync(AuditRow)
const decodeSnapshotRow = Schema.decodeUnknownSync(SnapshotRow)
const decodeJsonText = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))
const decodeCapabilities = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(Schema.Literals([
    "provision_connections",
    "administer_gateway"
  ])))
)
const decodeApprovalDelivery = Schema.decodeUnknownSync(Schema.fromJsonString(ApprovalDelivery))

const parseJsonColumn = (value: string): typeof Schema.Json.Type =>
  decodeJsonText(value)

const date = (value: number): Date => new Date(value)
const nullableDate = (value: number | null): Date | null =>
  value === null ? null : new Date(value)
export const millis = (value: Date): number => value.getTime()

export const toClient = (row: Row): Client => {
  const decoded = decodeClientRow(pick(row, clientColumns))
  return {
    id: ClientId.make(decoded.id),
    tenantId: TenantId.make(decoded.tenant_id),
    accessProfileId: AccessProfileId.make(decoded.access_profile_id),
    approvalPolicyId: ApprovalPolicyId.make(decoded.approval_policy_id),
    name: decoded.name,
    capabilities: decodeCapabilities(decoded.capabilities),
    approvalDelivery: decodeApprovalDelivery(decoded.approval_delivery),
    createdAt: date(decoded.created_at),
    revokedAt: nullableDate(decoded.revoked_at)
  }
}

export const toApprovalDestination = (row: Row): ApprovalDestination => {
  const decoded = Schema.decodeUnknownSync(ApprovalDestinationRow)(pick(row, ["id", "tenant_id", "name", "type", "url", "created_at"]))
  return {
    id: ApprovalDestinationId.make(decoded.id),
    tenantId: TenantId.make(decoded.tenant_id),
    name: decoded.name,
    type: decoded.type,
    url: decoded.url,
    createdAt: date(decoded.created_at)
  }
}

export const toApprovalDeliveryAttempt = (row: Row): ApprovalDeliveryAttempt => {
  const decoded = Schema.decodeUnknownSync(ApprovalDeliveryRow)(pick(row, ["id", "approval_id", "destination_id", "destination_name", "status", "attempts", "next_attempt_at", "delivered_at", "last_error"]))
  return {
    id: ApprovalDeliveryId.make(decoded.id),
    approvalId: ApprovalId.make(decoded.approval_id),
    destinationId: ApprovalDestinationId.make(decoded.destination_id),
    destinationName: decoded.destination_name,
    status: decoded.status,
    attempts: decoded.attempts,
    nextAttemptAt: nullableDate(decoded.next_attempt_at),
    deliveredAt: nullableDate(decoded.delivered_at),
    lastError: decoded.last_error
  }
}

export const toTenant = (row: Row): Tenant => {
  const decoded = decodeTenantRow(pick(row, tenantColumns))
  return {
    id: TenantId.make(decoded.id),
    name: decoded.name,
    createdAt: date(decoded.created_at)
  }
}

export const toSubject = (row: Row): Subject => {
  const decoded = decodeSubjectRow(pick(row, subjectColumns))
  return {
    id: SubjectId.make(decoded.id),
    tenantId: TenantId.make(decoded.tenant_id),
    createdAt: date(decoded.created_at)
  }
}

export const toLoginRecord = (row: Row): LoginRecord => {
  const decoded = decodeLoginRow(pick(row, loginColumns))
  return {
    subjectId: SubjectId.make(decoded.subject_id),
    tenantId: TenantId.make(decoded.tenant_id),
    email: decoded.email,
    passwordHash: decoded.password_hash === null ? null : PasswordHash.make(decoded.password_hash),
    createdAt: date(decoded.created_at)
  }
}

export const toExternalIdentity = (row: Row): ExternalIdentity => {
  const decoded = decodeExternalIdentityRow(pick(row, externalIdentityColumns))
  return {
    provider: decoded.provider,
    providerSubject: decoded.provider_subject,
    subjectId: SubjectId.make(decoded.subject_id),
    tenantId: TenantId.make(decoded.tenant_id),
    email: decoded.email,
    createdAt: date(decoded.created_at)
  }
}

export const toLoginHandoff = (row: Row): LoginHandoff => {
  const decoded = decodeLoginHandoffRow(pick(row, loginHandoffColumns))
  return {
    requestHash: LoginHandoffHash.make(decoded.request_hash),
    subjectId: decoded.subject_id === null ? null : SubjectId.make(decoded.subject_id),
    tenantId: decoded.tenant_id === null ? null : TenantId.make(decoded.tenant_id),
    email: decoded.email,
    createdAt: date(decoded.created_at),
    expiresAt: date(decoded.expires_at),
    collectedAt: nullableDate(decoded.collected_at)
  }
}

export const toIdentityOAuthState = (row: Row): IdentityOAuthStateRecord => {
  const decoded = decodeIdentityOAuthStateRow(pick(row, identityOAuthStateColumns))
  return {
    stateHash: LoginHandoffHash.make(decoded.state_hash),
    provider: decoded.provider,
    handoffHash: decoded.handoff_hash === null
      ? null
      : LoginHandoffHash.make(decoded.handoff_hash),
    returnPath: decoded.return_path,
    expiresAt: date(decoded.expires_at)
  }
}

export const toAuthSession = (row: Row): AuthSession => {
  const decoded = decodeSessionRow(pick(row, sessionColumns))
  return {
    tokenHash: SessionTokenHash.make(decoded.token_hash),
    tenantId: TenantId.make(decoded.tenant_id),
    subjectId: SubjectId.make(decoded.subject_id),
    // Joined from the login; a session always has one.
    email: String(row["email"] ?? ""),
    createdAt: date(decoded.created_at),
    expiresAt: date(decoded.expires_at)
  }
}

export const toApiKey = (row: Row): ApiKey => {
  const decoded = decodeApiKeyRow(pick(row, apiKeyColumns))
  return {
    id: ApiKeyId.make(decoded.id),
    clientId: ClientId.make(decoded.client_id),
    hash: ApiKeyHash.make(decoded.hash),
    createdAt: date(decoded.created_at),
    lastUsedAt: nullableDate(decoded.last_used_at),
    revokedAt: nullableDate(decoded.revoked_at)
  }
}

const toConnectionRef = (fields: {
  readonly owner: "org" | "user"
  readonly subject: string | null
  readonly integration: string
  readonly connection_name: string
}): ConnectionRef => {
  const integration = IntegrationSlug.make(fields.integration)
  const name = ConnectionName.make(fields.connection_name)
  if (fields.owner === "org") return { owner: "org", integration, name }
  if (fields.subject === null) {
    throw new Error(`User-tier connection ${fields.integration}/${fields.connection_name} has no subject`)
  }
  return { owner: "user", subject: SubjectId.make(fields.subject), integration, name }
}

export const toAccessProfile = (row: Row): AccessProfile => {
  const decoded = decodeConfigurationRow(pick(row, configurationColumns))
  return {
    id: AccessProfileId.make(decoded.id),
    tenantId: TenantId.make(decoded.tenant_id),
    name: decoded.name,
    isDefault: decoded.is_default === 1,
    createdAt: date(decoded.created_at),
    updatedAt: date(decoded.updated_at)
  }
}

export const toAccessProfileTool = (row: Row): AccessProfileTool => {
  const decoded = decodeAccessProfileToolRow(pick(row, accessProfileToolColumns))
  return {
    accessProfileId: AccessProfileId.make(decoded.access_profile_id),
    connection: toConnectionRef(decoded),
    tool: ToolName.make(decoded.tool)
  }
}

export const toApprovalPolicy = (row: Row): ApprovalPolicy => {
  const decoded = decodeConfigurationRow(pick(row, configurationColumns))
  return {
    id: ApprovalPolicyId.make(decoded.id),
    tenantId: TenantId.make(decoded.tenant_id),
    name: decoded.name,
    isDefault: decoded.is_default === 1,
    createdAt: date(decoded.created_at),
    updatedAt: date(decoded.updated_at)
  }
}

export const toApprovalPolicyTool = (row: Row): ApprovalPolicyTool => {
  const decoded = decodeApprovalPolicyToolRow(pick(row, approvalPolicyToolColumns))
  return {
    approvalPolicyId: ApprovalPolicyId.make(decoded.approval_policy_id),
    connection: toConnectionRef(decoded),
    tool: ToolName.make(decoded.tool),
    decision: decoded.decision
  }
}

/** Reads a stored approval back into the domain. `open` undoes whatever the
 *  write side did to `arguments`/`result`; for plaintext stores it is the
 *  identity, so one reader serves both worlds. */
export const toApproval = (row: Row, open: (text: string) => string = identity): PendingApproval => {
  const decoded = decodeApprovalRow(pick(row, approvalColumns))
  return {
    id: ApprovalId.make(decoded.id),
    clientId: ClientId.make(decoded.client_id),
    approvalPolicyId: ApprovalPolicyId.make(decoded.approval_policy_id),
    accessProfileId: AccessProfileId.make(decoded.access_profile_id),
    alias: Alias.make(decoded.alias),
    tool: ToolName.make(decoded.tool),
    arguments: parseJsonColumn(open(decoded.arguments)),
    status: decoded.status,
    createdAt: date(decoded.created_at),
    expiresAt: date(decoded.expires_at),
    decidedAt: nullableDate(decoded.decided_at),
    decidedBy: decoded.decided_by,
    result: decoded.result === null ? null : parseJsonColumn(open(decoded.result)),
    error: decoded.error,
    collectedAt: nullableDate(decoded.collected_at)
  }
}

const identity = (text: string): string => text

export const toAuditRecord = (row: Row): AuditRecord => {
  const decoded = decodeAuditRow(pick(row, auditColumns))
  return {
    id: AuditId.make(decoded.id),
    clientId: decoded.client_id === null ? null : ClientId.make(decoded.client_id),
    alias: decoded.alias === null ? null : Alias.make(decoded.alias),
    tool: decoded.tool === null ? null : ToolName.make(decoded.tool),
    connection: decoded.owner === null || decoded.integration === null || decoded.connection_name === null
      ? null
      : toConnectionRef({
        owner: decoded.owner,
        subject: decoded.subject,
        integration: decoded.integration,
        connection_name: decoded.connection_name
      }),
    subject: decoded.subject === null ? null : SubjectId.make(decoded.subject),
    decision: decoded.decision,
    outcome: decoded.outcome,
    message: decoded.message,
    createdAt: date(decoded.created_at)
  }
}

export const toSnapshot = (row: Row): ToolSnapshot => {
  const decoded = decodeSnapshotRow(pick(row, snapshotColumns))
  return {
    integration: IntegrationSlug.make(decoded.integration),
    connection: ConnectionName.make(decoded.connection_name),
    tool: ToolName.make(decoded.tool),
    inputSchema: decoded.input_schema === null ? null : parseJsonColumn(decoded.input_schema),
    outputSchema: decoded.output_schema === null ? null : parseJsonColumn(decoded.output_schema),
    syncedAt: date(decoded.synced_at)
  }
}
