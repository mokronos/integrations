import { ApprovalStatus } from "./domain.ts"
import type { Row } from "@libsql/client"
import { Schema } from "effect"
import {
  AccessProfileId, ApiKeyHash, ApiKeyId, ApprovalDeliveryId, ApprovalMethod, McpSurface,
  ApprovalDestinationId, ApprovalId,
  ApprovalPolicyId, AuditId, ClientId, ConnectionName, IntegrationSlug,
  LoginHandoffHash, SessionTokenHash, SubjectId, TenantId, ToolName,
  OAuthApplicationId, OAuthGrantId, OAuthApplicationKind
} from "./domain.ts"
import type {
  AccessProfile, AccessProfileTool, ApiKey, ApprovalDeliveryAttempt, ApprovalDestination, ApprovalPolicy, ApprovalPolicyTool,
  AuditRecord, AuthSession, Client, ConnectionRef, ExternalIdentity, LoginHandoff,
  PendingApproval, Subject, Tenant, ToolSnapshot
} from "./domain.ts"
import { PasswordHash } from "./passwords.ts"
import type { IdentityOAuthStateRecord, LoginRecord } from "./store-contract.ts"
import { OAuthSecretHash, OAuthTokenKind } from "./mcp-oauth.ts"
import type {
  OAuthApplication, OAuthAuthorizationCode, OAuthAuthorizationRequest, OAuthGrant, OAuthToken
} from "./mcp-oauth.ts"

type PickedRow = Record<string, Row[string]>

const pick = (row: Row, keys: ReadonlyArray<string>): PickedRow =>
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
  mcp_surface: McpSurface,
  approval_method: ApprovalMethod,
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

const OAuthApplicationRow = Schema.Struct({
  id: Schema.String,
  kind: OAuthApplicationKind,
  client_identifier: Schema.String,
  name: Schema.String,
  redirect_uris_json: Schema.String,
  metadata_json: Schema.String,
  created_at: Schema.Number,
  updated_at: Schema.Number,
  revoked_at: NullableNumber
})

const OAuthAuthorizationRequestRow = Schema.Struct({
  id: Schema.String,
  application_id: Schema.String,
  redirect_uri: Schema.String,
  state: NullableString,
  code_challenge: Schema.String,
  resource: Schema.String,
  scope: Schema.Literal("mcp"),
  created_at: Schema.Number,
  expires_at: Schema.Number,
  consumed_at: NullableNumber
})

const OAuthGrantRow = Schema.Struct({
  id: Schema.String,
  application_id: Schema.String,
  subject_id: Schema.String,
  tenant_id: Schema.String,
  client_id: Schema.String,
  resource: Schema.String,
  scope: Schema.Literal("mcp"),
  created_at: Schema.Number,
  last_used_at: NullableNumber,
  revoked_at: NullableNumber
})

const OAuthAuthorizationCodeRow = Schema.Struct({
  hash: Schema.String,
  grant_id: Schema.String,
  application_id: Schema.String,
  redirect_uri: Schema.String,
  code_challenge: Schema.String,
  resource: Schema.String,
  scope: Schema.Literal("mcp"),
  created_at: Schema.Number,
  expires_at: Schema.Number,
  consumed_at: NullableNumber
})

const OAuthTokenRow = Schema.Struct({
  hash: Schema.String,
  kind: OAuthTokenKind,
  family_id: Schema.String,
  grant_id: Schema.String,
  application_id: Schema.String,
  resource: Schema.String,
  scope: Schema.Literal("mcp"),
  created_at: Schema.Number,
  expires_at: Schema.Number,
  used_at: NullableNumber,
  revoked_at: NullableNumber,
  replaced_by_hash: NullableString
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
  oauth_grant_id: NullableString,
  oauth_application_id: NullableString,
  authorized_by_subject_id: NullableString,
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
  "id", "tenant_id", "access_profile_id", "approval_policy_id", "name", "capabilities", "approval_method", "mcp_surface", "created_at", "revoked_at"
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
  "id", "client_id", "oauth_grant_id", "oauth_application_id", "authorized_by_subject_id", "alias", "tool", "owner", "subject", "integration",
  "connection_name", "decision", "outcome", "message", "created_at"
]
const snapshotColumns = [
  "integration", "connection_name", "tool", "input_schema", "output_schema", "synced_at"
]

export class MalformedRowError extends Error {
  readonly _tag = "MalformedRowError"
  constructor(readonly table: string, override readonly cause: unknown) {
    super(`Malformed ${table} row`)
  }
}

const rowDecoder = <T>(table: string, schema: Schema.ConstraintDecoder<T>) => {
  const decode = Schema.decodeUnknownSync(schema)
  return (columns: PickedRow): T => {
    try {
      return decode(columns)
    } catch (cause) {
      throw new MalformedRowError(table, cause)
    }
  }
}

const jsonDecoder = <T>(column: string, schema: Schema.ConstraintDecoder<T>) => {
  const decode = Schema.decodeUnknownSync(schema)
  return (text: string): T => {
    try {
      return decode(text)
    } catch (cause) {
      throw new MalformedRowError(column, cause)
    }
  }
}

const decodeClientRow = rowDecoder("gateway_client", ClientRow)
const decodeTenantRow = rowDecoder("gateway_tenant", TenantRow)
const decodeSubjectRow = rowDecoder("gateway_subject", SubjectRow)
const decodeLoginRow = rowDecoder("gateway_login", LoginRow)
const decodeSessionRow = rowDecoder("gateway_session", SessionRow)
const decodeExternalIdentityRow = rowDecoder("gateway_external_identity", ExternalIdentityRow)
const decodeLoginHandoffRow = rowDecoder("gateway_login_handoff", LoginHandoffRow)
const decodeIdentityOAuthStateRow = rowDecoder("gateway_identity_oauth_state", IdentityOAuthStateRow)
const decodeApiKeyRow = rowDecoder("gateway_api_key", ApiKeyRow)
const decodeConfigurationRow = rowDecoder("gateway_configuration", ConfigurationRow)
const decodeAccessProfileToolRow = rowDecoder("gateway_access_profile_tool", AccessProfileToolRow)
const decodeApprovalPolicyToolRow = rowDecoder("gateway_approval_policy_tool", ApprovalPolicyToolRow)
const decodeApprovalRow = rowDecoder("gateway_approval", ApprovalRow)
const decodeAuditRow = rowDecoder("gateway_audit", AuditRow)
const decodeSnapshotRow = rowDecoder("gateway_tool_snapshot", SnapshotRow)
const decodeJsonText = jsonDecoder("json column", Schema.fromJsonString(Schema.Json))
const decodeCapabilities = jsonDecoder(
  "gateway_client.capabilities",
  Schema.fromJsonString(Schema.Array(Schema.Literals([
    "provision_connections",
    "administer_gateway"
  ])))
)

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
    approvalMethod: decoded.approval_method,
    mcpSurface: decoded.mcp_surface,
    createdAt: date(decoded.created_at),
    revokedAt: nullableDate(decoded.revoked_at)
  }
}

export const toApprovalDestination = (row: Row): ApprovalDestination => {
  const decoded = rowDecoder("gateway_approval_destination", ApprovalDestinationRow)(pick(row, ["id", "tenant_id", "name", "type", "url", "created_at"]))
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
  const decoded = rowDecoder("gateway_approval_delivery", ApprovalDeliveryRow)(pick(row, ["id", "approval_id", "destination_id", "destination_name", "status", "attempts", "next_attempt_at", "delivered_at", "last_error"]))
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

const stringArrayFromJson = jsonDecoder(
  "redirect_uris_json",
  Schema.fromJsonString(Schema.Array(Schema.String))
)

export const toOAuthApplication = (row: Row): OAuthApplication => {
  const decoded = rowDecoder("gateway_oauth_application", OAuthApplicationRow)(pick(row, [
    "id", "kind", "client_identifier", "name", "redirect_uris_json", "metadata_json",
    "created_at", "updated_at", "revoked_at"
  ]))
  return {
    id: OAuthApplicationId.make(decoded.id),
    kind: decoded.kind,
    clientIdentifier: decoded.client_identifier,
    name: decoded.name,
    redirectUris: stringArrayFromJson(decoded.redirect_uris_json),
    metadata: parseJsonColumn(decoded.metadata_json),
    createdAt: date(decoded.created_at),
    updatedAt: date(decoded.updated_at),
    revokedAt: nullableDate(decoded.revoked_at)
  }
}

export const toOAuthAuthorizationRequest = (row: Row): OAuthAuthorizationRequest => {
  const decoded = rowDecoder("gateway_oauth_authorization_request", OAuthAuthorizationRequestRow)(pick(row, [
    "id", "application_id", "redirect_uri", "state", "code_challenge", "resource", "scope",
    "created_at", "expires_at", "consumed_at"
  ]))
  return {
    id: decoded.id,
    applicationId: OAuthApplicationId.make(decoded.application_id),
    redirectUri: decoded.redirect_uri,
    state: decoded.state,
    codeChallenge: decoded.code_challenge,
    resource: decoded.resource,
    scope: decoded.scope,
    createdAt: date(decoded.created_at),
    expiresAt: date(decoded.expires_at),
    consumedAt: nullableDate(decoded.consumed_at)
  }
}

export const toOAuthGrant = (row: Row): OAuthGrant => {
  const decoded = rowDecoder("gateway_oauth_grant", OAuthGrantRow)(pick(row, [
    "id", "application_id", "subject_id", "tenant_id", "client_id", "resource", "scope",
    "created_at", "last_used_at", "revoked_at"
  ]))
  return {
    id: OAuthGrantId.make(decoded.id),
    applicationId: OAuthApplicationId.make(decoded.application_id),
    subjectId: SubjectId.make(decoded.subject_id),
    tenantId: TenantId.make(decoded.tenant_id),
    clientId: ClientId.make(decoded.client_id),
    resource: decoded.resource,
    scope: decoded.scope,
    createdAt: date(decoded.created_at),
    lastUsedAt: nullableDate(decoded.last_used_at),
    revokedAt: nullableDate(decoded.revoked_at)
  }
}

export const toOAuthAuthorizationCode = (row: Row): OAuthAuthorizationCode => {
  const decoded = rowDecoder("gateway_oauth_authorization_code", OAuthAuthorizationCodeRow)(pick(row, [
    "hash", "grant_id", "application_id", "redirect_uri", "code_challenge", "resource", "scope",
    "created_at", "expires_at", "consumed_at"
  ]))
  return {
    hash: OAuthSecretHash.make(decoded.hash),
    grantId: OAuthGrantId.make(decoded.grant_id),
    applicationId: OAuthApplicationId.make(decoded.application_id),
    redirectUri: decoded.redirect_uri,
    codeChallenge: decoded.code_challenge,
    resource: decoded.resource,
    scope: decoded.scope,
    createdAt: date(decoded.created_at),
    expiresAt: date(decoded.expires_at),
    consumedAt: nullableDate(decoded.consumed_at)
  }
}

export const toOAuthToken = (row: Row): OAuthToken => {
  const decoded = rowDecoder("gateway_oauth_token", OAuthTokenRow)(pick(row, [
    "hash", "kind", "family_id", "grant_id", "application_id", "resource", "scope",
    "created_at", "expires_at", "used_at", "revoked_at", "replaced_by_hash"
  ]))
  return {
    hash: OAuthSecretHash.make(decoded.hash),
    kind: decoded.kind,
    familyId: decoded.family_id,
    grantId: OAuthGrantId.make(decoded.grant_id),
    applicationId: OAuthApplicationId.make(decoded.application_id),
    resource: decoded.resource,
    scope: decoded.scope,
    createdAt: date(decoded.created_at),
    expiresAt: date(decoded.expires_at),
    usedAt: nullableDate(decoded.used_at),
    revokedAt: nullableDate(decoded.revoked_at),
    replacedByHash: decoded.replaced_by_hash === null ? null : OAuthSecretHash.make(decoded.replaced_by_hash)
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
  if (fields.subject === null) return { owner: "user", integration, name }
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

export const toApproval = (row: Row, open: (text: string) => string = identity): PendingApproval => {
  const decoded = decodeApprovalRow(pick(row, approvalColumns))
  return {
    id: ApprovalId.make(decoded.id),
    clientId: ClientId.make(decoded.client_id),
    approvalPolicyId: ApprovalPolicyId.make(decoded.approval_policy_id),
    accessProfileId: AccessProfileId.make(decoded.access_profile_id),
    alias: decoded.alias,
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
    oauthGrantId: decoded.oauth_grant_id === null ? null : OAuthGrantId.make(decoded.oauth_grant_id),
    oauthApplicationId: decoded.oauth_application_id === null ? null : OAuthApplicationId.make(decoded.oauth_application_id),
    authorizedBySubjectId: decoded.authorized_by_subject_id === null ? null : SubjectId.make(decoded.authorized_by_subject_id),
    alias: decoded.alias,
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
