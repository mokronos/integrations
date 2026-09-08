import { Schema } from "effect"

export const TenantId = Schema.String.pipe(Schema.brand("TenantId"))
export type TenantId = typeof TenantId.Type

export const SubjectId = Schema.String.pipe(Schema.brand("SubjectId"))
export type SubjectId = typeof SubjectId.Type

export const ClientId = Schema.String.pipe(Schema.brand("ClientId"))
export type ClientId = typeof ClientId.Type

export const ApiKeyId = Schema.String.pipe(Schema.brand("ApiKeyId"))
export type ApiKeyId = typeof ApiKeyId.Type

export const AccessProfileId = Schema.String.pipe(Schema.brand("AccessProfileId"))
export type AccessProfileId = typeof AccessProfileId.Type

export const ApprovalPolicyId = Schema.String.pipe(Schema.brand("ApprovalPolicyId"))
export type ApprovalPolicyId = typeof ApprovalPolicyId.Type

export const ApprovalId = Schema.String.pipe(Schema.brand("ApprovalId"))
export type ApprovalId = typeof ApprovalId.Type

export const ApprovalDestinationId = Schema.String.pipe(Schema.brand("ApprovalDestinationId"))
export type ApprovalDestinationId = typeof ApprovalDestinationId.Type

export const ApprovalDeliveryId = Schema.String.pipe(Schema.brand("ApprovalDeliveryId"))
export type ApprovalDeliveryId = typeof ApprovalDeliveryId.Type

export const AuditId = Schema.String.pipe(Schema.brand("AuditId"))
export type AuditId = typeof AuditId.Type

import { Alias, ApprovalStatus, ConnectionName, IntegrationSlug, ToolName } from "@mokronos/contracts"

export { Alias, ApprovalStatus, ConnectionName, IntegrationSlug, ToolName }

export const ApiKeyHash = Schema.String.pipe(Schema.brand("ApiKeyHash"))
export type ApiKeyHash = typeof ApiKeyHash.Type

export const SessionTokenHash = Schema.String.pipe(Schema.brand("SessionTokenHash"))
export type SessionTokenHash = typeof SessionTokenHash.Type

export const LoginHandoffHash = Schema.String.pipe(Schema.brand("LoginHandoffHash"))
export type LoginHandoffHash = typeof LoginHandoffHash.Type

export const defaultTenantId = TenantId.make("default")

export const Tenant = Schema.Struct({
  id: TenantId,
  name: Schema.String,
  createdAt: Schema.Date
})
export type Tenant = typeof Tenant.Type

export const Subject = Schema.Struct({
  id: SubjectId,
  tenantId: TenantId,
  createdAt: Schema.Date
})
export type Subject = typeof Subject.Type

export const Login = Schema.Struct({
  subjectId: SubjectId,
  tenantId: TenantId,
  email: Schema.String,
  createdAt: Schema.Date
})
export type Login = typeof Login.Type

export const AuthSession = Schema.Struct({
  tokenHash: SessionTokenHash,
  tenantId: TenantId,
  subjectId: SubjectId,
  email: Schema.String,
  createdAt: Schema.Date,
  expiresAt: Schema.Date
})
export type AuthSession = typeof AuthSession.Type

export const IdentityProvider = Schema.Literal("google")
export type IdentityProvider = typeof IdentityProvider.Type

export const ExternalIdentity = Schema.Struct({
  provider: IdentityProvider,
  providerSubject: Schema.String,
  tenantId: TenantId,
  subjectId: SubjectId,
  email: Schema.String,
  createdAt: Schema.Date
})
export type ExternalIdentity = typeof ExternalIdentity.Type

export const LoginHandoff = Schema.Struct({
  requestHash: LoginHandoffHash,
  subjectId: Schema.NullOr(SubjectId),
  tenantId: Schema.NullOr(TenantId),
  email: Schema.NullOr(Schema.String),
  createdAt: Schema.Date,
  expiresAt: Schema.Date,
  collectedAt: Schema.NullOr(Schema.Date)
})
export type LoginHandoff = typeof LoginHandoff.Type

export const OwnerTier = Schema.Literals(["org", "user"])
export type OwnerTier = typeof OwnerTier.Type

export const ConnectionRef = Schema.Union([
  Schema.Struct({
    owner: Schema.Literal("org"),
    integration: IntegrationSlug,
    name: ConnectionName
  }),
  Schema.Struct({
    owner: Schema.Literal("user"),
    subject: SubjectId,
    integration: IntegrationSlug,
    name: ConnectionName
  })
])
export type ConnectionRef = typeof ConnectionRef.Type

export const connectionSubject = (connection: ConnectionRef): SubjectId | undefined =>
  connection.owner === "user" ? connection.subject : undefined

export const connectionRefKey = (connection: ConnectionRef): string =>
  [
    connection.owner,
    connectionSubject(connection) ?? "",
    connection.integration,
    connection.name
  ].join("\u0000")

export const sameConnectionRef = (left: ConnectionRef, right: ConnectionRef): boolean =>
  connectionRefKey(left) === connectionRefKey(right)

const utf8 = new TextEncoder()

const aliasPart = (value: string): string =>
  Array.from(utf8.encode(value), (byte) =>
    byte >= 0x61 && byte <= 0x7a || byte >= 0x30 && byte <= 0x39
      ? String.fromCharCode(byte)
      : `-${byte.toString(16).padStart(2, "0")}`).join("")

export const aliasForConnection = (connection: ConnectionRef): Alias =>
  Alias.make([
    connection.owner,
    ...connection.owner === "user" ? [aliasPart(connection.subject)] : [],
    aliasPart(connection.integration),
    aliasPart(connection.name)
  ].join("_"))

export const ClientCapability = Schema.Literals([
  "provision_connections",
  "administer_gateway"
])
export type ClientCapability = typeof ClientCapability.Type

export const ApprovalDelivery = Schema.Struct({
  returnLink: Schema.Boolean
})
export type ApprovalDelivery = typeof ApprovalDelivery.Type

export const defaultApprovalDelivery: ApprovalDelivery = {
  returnLink: true
}

export const ApprovalDestination = Schema.Struct({
  id: ApprovalDestinationId,
  tenantId: TenantId,
  name: Schema.String,
  type: Schema.Literal("webhook"),
  url: Schema.String.check(Schema.isPattern(/^https:\/\/[^\s]+$/)),
  createdAt: Schema.Date
})
export type ApprovalDestination = typeof ApprovalDestination.Type

export const ApprovalDeliveryStatus = Schema.Literals(["pending", "retrying", "delivered", "failed"])
export type ApprovalDeliveryStatus = typeof ApprovalDeliveryStatus.Type

export const ApprovalDeliveryAttempt = Schema.Struct({
  id: ApprovalDeliveryId,
  approvalId: ApprovalId,
  destinationId: ApprovalDestinationId,
  destinationName: Schema.String,
  status: ApprovalDeliveryStatus,
  attempts: Schema.Number,
  nextAttemptAt: Schema.NullOr(Schema.Date),
  deliveredAt: Schema.NullOr(Schema.Date),
  lastError: Schema.NullOr(Schema.String)
})
export type ApprovalDeliveryAttempt = typeof ApprovalDeliveryAttempt.Type

export const Client = Schema.Struct({
  id: ClientId,
  tenantId: TenantId,
  accessProfileId: AccessProfileId,
  approvalPolicyId: ApprovalPolicyId,
  name: Schema.String,
  capabilities: Schema.Array(ClientCapability),
  approvalDelivery: ApprovalDelivery,
  createdAt: Schema.Date,
  revokedAt: Schema.NullOr(Schema.Date)
})
export type Client = typeof Client.Type

export const clientHasCapability = (
  client: Client,
  capability: ClientCapability
): boolean => client.capabilities.includes(capability)

export const ApiKey = Schema.Struct({
  id: ApiKeyId,
  clientId: ClientId,
  hash: ApiKeyHash,
  createdAt: Schema.Date,
  lastUsedAt: Schema.NullOr(Schema.Date),
  revokedAt: Schema.NullOr(Schema.Date)
})
export type ApiKey = typeof ApiKey.Type

export const PolicyDecision = Schema.Literals(["allow", "require_approval"])
export type PolicyDecision = typeof PolicyDecision.Type

const ReusableConfiguration = {
  tenantId: TenantId,
  name: Schema.String,
  isDefault: Schema.Boolean,
  createdAt: Schema.Date,
  updatedAt: Schema.Date
}

export const AccessProfile = Schema.Struct({
  id: AccessProfileId,
  ...ReusableConfiguration
})
export type AccessProfile = typeof AccessProfile.Type

export const AccessProfileTool = Schema.Struct({
  accessProfileId: AccessProfileId,
  connection: ConnectionRef,
  tool: ToolName
})
export type AccessProfileTool = typeof AccessProfileTool.Type

export const ApprovalPolicy = Schema.Struct({
  id: ApprovalPolicyId,
  ...ReusableConfiguration
})
export type ApprovalPolicy = typeof ApprovalPolicy.Type

export const ApprovalPolicyTool = Schema.Struct({
  approvalPolicyId: ApprovalPolicyId,
  connection: ConnectionRef,
  tool: ToolName,
  decision: PolicyDecision
})
export type ApprovalPolicyTool = typeof ApprovalPolicyTool.Type

export const Authorization = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("authorized"),
    client: Client,
    accessProfile: AccessProfile,
    accessProfileTool: AccessProfileTool,
    approvalPolicy: ApprovalPolicy,
    approvalPolicyTool: ApprovalPolicyTool,
    alias: Alias,
    connection: ConnectionRef,
    subject: Schema.NullOr(SubjectId),
    decision: PolicyDecision
  }),
  Schema.Struct({ status: Schema.Literal("unknown-key") }),
  Schema.Struct({ status: Schema.Literal("key-revoked") }),
  Schema.Struct({ status: Schema.Literal("client-revoked") }),
  Schema.Struct({
    status: Schema.Literal("not-authorized"),
    alias: Alias,
    tool: ToolName
  })
])
export type Authorization = typeof Authorization.Type

export const describeAuthorization = (authorization: Authorization): string => {
  switch (authorization.status) {
    case "authorized":
      return `authorized ${authorization.alias}.${authorization.accessProfileTool.tool}`
    case "unknown-key":
      return "the presented API key is not recognised"
    case "key-revoked":
      return "the presented API key has been revoked"
    case "client-revoked":
      return "the client this key belongs to has been revoked"
    case "not-authorized":
      return `${authorization.alias}.${authorization.tool} is not authorized for this client`
  }
}

export const ConfigureClient = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1)),
  tools: Schema.Array(Schema.Struct({
    connection: ConnectionRef,
    tool: ToolName,
    decision: PolicyDecision
  })).check(Schema.isMinLength(1))
})
export type ConfigureClient = typeof ConfigureClient.Type


export const PendingApproval = Schema.Struct({
  id: ApprovalId,
  clientId: ClientId,
  approvalPolicyId: ApprovalPolicyId,
  accessProfileId: AccessProfileId,
  alias: Alias,
  tool: ToolName,
  arguments: Schema.Json,
  status: ApprovalStatus,
  createdAt: Schema.Date,
  expiresAt: Schema.Date,
  decidedAt: Schema.NullOr(Schema.Date),
  decidedBy: Schema.NullOr(Schema.String),
  result: Schema.NullOr(Schema.Json),
  error: Schema.NullOr(Schema.String),
  collectedAt: Schema.NullOr(Schema.Date)
})
export type PendingApproval = typeof PendingApproval.Type

export const canonicalArguments = (value: Schema.Json): string =>
  JSON.stringify(canonicalise(value))

const isJsonObject = Schema.is(Schema.Record(Schema.String, Schema.Json))

const canonicalise = (value: Schema.Json): Schema.Json => {
  if (Array.isArray(value)) return value.map(canonicalise)
  if (isJsonObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, nested]) => [key, canonicalise(nested)])
    )
  }
  return value
}

export const AuditOutcome = Schema.Literals([
  "succeeded",
  "failed",
  "denied",
  "pending"
])
export type AuditOutcome = typeof AuditOutcome.Type

export const AuditRecord = Schema.Struct({
  id: AuditId,
  clientId: Schema.NullOr(ClientId),
  alias: Schema.NullOr(Alias),
  tool: Schema.NullOr(ToolName),
  connection: Schema.NullOr(ConnectionRef),
  subject: Schema.NullOr(SubjectId),
  decision: Schema.NullOr(PolicyDecision),
  outcome: AuditOutcome,
  message: Schema.NullOr(Schema.String),
  createdAt: Schema.Date
})
export type AuditRecord = typeof AuditRecord.Type

export const AuditArguments = Schema.Struct({
  auditId: AuditId,
  arguments: Schema.Json,
  expiresAt: Schema.Date
})
export type AuditArguments = typeof AuditArguments.Type

export const ToolSnapshot = Schema.Struct({
  integration: IntegrationSlug,
  connection: ConnectionName,
  tool: ToolName,
  inputSchema: Schema.NullOr(Schema.Json),
  outputSchema: Schema.NullOr(Schema.Json),
  syncedAt: Schema.Date
})
export type ToolSnapshot = typeof ToolSnapshot.Type

export const DriftKind = Schema.Literals(["added", "removed", "changed"])
export type DriftKind = typeof DriftKind.Type

export const DriftEntry = Schema.Struct({
  kind: DriftKind,
  integration: IntegrationSlug,
  connection: ConnectionName,
  tool: ToolName
})
export type DriftEntry = typeof DriftEntry.Type
