import { Schema } from "effect"
import { Alias, ApprovalStatus, ConnectionName, IntegrationSlug, OwnerTier, ToolName } from "./vocabulary.ts"

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

export const ConnectionRef = Schema.Union([
  Schema.Struct({ owner: Schema.Literal("org"), integration: IntegrationSlug, name: ConnectionName }),
  Schema.Struct({ owner: Schema.Literal("user"), subject: SubjectId, integration: IntegrationSlug, name: ConnectionName })
])
export type ConnectionRef = typeof ConnectionRef.Type
export const connectionSubject = (connection: ConnectionRef): SubjectId | undefined => connection.owner === "user" ? connection.subject : undefined
export const connectionRefKey = (connection: ConnectionRef): string => [connection.owner, connectionSubject(connection) ?? "", connection.integration, connection.name].join("\u0000")
export const sameConnectionRef = (left: ConnectionRef, right: ConnectionRef): boolean => connectionRefKey(left) === connectionRefKey(right)
const utf8 = new TextEncoder()
const aliasPart = (value: string): string => Array.from(utf8.encode(value), (byte) => byte >= 0x61 && byte <= 0x7a || byte >= 0x30 && byte <= 0x39 ? String.fromCharCode(byte) : `-${byte.toString(16).padStart(2, "0")}`).join("")
export const aliasForConnection = (connection: ConnectionRef): Alias => Alias.make([connection.owner, ...connection.owner === "user" ? [aliasPart(connection.subject)] : [], aliasPart(connection.integration), aliasPart(connection.name)].join("_"))

export const ClientCapability = Schema.Literals(["provision_connections", "administer_gateway"])
export type ClientCapability = typeof ClientCapability.Type
export const ApprovalDelivery = Schema.Struct({ returnLink: Schema.Boolean })
export type ApprovalDelivery = typeof ApprovalDelivery.Type
export const PolicyDecision = Schema.Literals(["allow", "require_approval"])
export type PolicyDecision = typeof PolicyDecision.Type

export const Client = Schema.Struct({
  id: ClientId, tenantId: TenantId, accessProfileId: AccessProfileId, approvalPolicyId: ApprovalPolicyId,
  name: Schema.String, capabilities: Schema.Array(ClientCapability), approvalDelivery: ApprovalDelivery,
  createdAt: Schema.Date, revokedAt: Schema.NullOr(Schema.Date)
})
export type Client = typeof Client.Type

export const ApiKeyView = Schema.Struct({ id: ApiKeyId, clientId: ClientId, createdAt: Schema.Date, lastUsedAt: Schema.NullOr(Schema.Date), revokedAt: Schema.NullOr(Schema.Date) })
export type ApiKeyView = typeof ApiKeyView.Type

const ReusableConfiguration = { tenantId: TenantId, name: Schema.String, isDefault: Schema.Boolean, createdAt: Schema.Date, updatedAt: Schema.Date }
export const AccessProfile = Schema.Struct({ id: AccessProfileId, ...ReusableConfiguration })
export type AccessProfile = typeof AccessProfile.Type
export const AccessProfileTool = Schema.Struct({ accessProfileId: AccessProfileId, connection: ConnectionRef, tool: ToolName })
export type AccessProfileTool = typeof AccessProfileTool.Type
export const ApprovalPolicy = Schema.Struct({ id: ApprovalPolicyId, ...ReusableConfiguration })
export type ApprovalPolicy = typeof ApprovalPolicy.Type
export const ApprovalPolicyTool = Schema.Struct({ approvalPolicyId: ApprovalPolicyId, connection: ConnectionRef, tool: ToolName, decision: PolicyDecision })
export type ApprovalPolicyTool = typeof ApprovalPolicyTool.Type

export const ApprovalDestination = Schema.Struct({ id: ApprovalDestinationId, tenantId: TenantId, name: Schema.String, type: Schema.Literal("webhook"), url: Schema.String.check(Schema.isPattern(/^https:\/\/[^\s]+$/)), createdAt: Schema.Date })
export type ApprovalDestination = typeof ApprovalDestination.Type
export const ApprovalDeliveryStatus = Schema.Literals(["pending", "retrying", "delivered", "failed"])
export type ApprovalDeliveryStatus = typeof ApprovalDeliveryStatus.Type
export const ApprovalDeliveryAttempt = Schema.Struct({ id: ApprovalDeliveryId, approvalId: ApprovalId, destinationId: ApprovalDestinationId, destinationName: Schema.String, status: ApprovalDeliveryStatus, attempts: Schema.Number, nextAttemptAt: Schema.NullOr(Schema.Date), deliveredAt: Schema.NullOr(Schema.Date), lastError: Schema.NullOr(Schema.String) })
export type ApprovalDeliveryAttempt = typeof ApprovalDeliveryAttempt.Type

export const PendingApproval = Schema.Struct({ id: ApprovalId, clientId: ClientId, approvalPolicyId: ApprovalPolicyId, accessProfileId: AccessProfileId, alias: Alias, tool: ToolName, arguments: Schema.Json, status: ApprovalStatus, createdAt: Schema.Date, expiresAt: Schema.Date, decidedAt: Schema.NullOr(Schema.Date), decidedBy: Schema.NullOr(Schema.String), result: Schema.NullOr(Schema.Json), error: Schema.NullOr(Schema.String), collectedAt: Schema.NullOr(Schema.Date) })
export type PendingApproval = typeof PendingApproval.Type
export const InvocationSucceeded = Schema.Struct({ status: Schema.Literal("succeeded"), result: Schema.Json })
export type InvocationSucceeded = typeof InvocationSucceeded.Type
export const InvocationPending = Schema.Struct({ status: Schema.Literal("pending"), approvalId: ApprovalId, expiresAt: Schema.Date, approvalUrl: Schema.optional(Schema.String) })
export type InvocationPending = typeof InvocationPending.Type
export const InvocationDenied = Schema.Struct({ status: Schema.Literal("denied"), reason: Schema.String })
export type InvocationDenied = typeof InvocationDenied.Type
export const InvocationFailed = Schema.Struct({ status: Schema.Literal("failed"), message: Schema.String })
export type InvocationFailed = typeof InvocationFailed.Type
export const InvocationOutcome = Schema.Union([InvocationSucceeded, InvocationPending, InvocationDenied, InvocationFailed])
export type InvocationOutcome = typeof InvocationOutcome.Type
export const AuditOutcome = Schema.Literals(["succeeded", "failed", "denied", "pending"])
export type AuditOutcome = typeof AuditOutcome.Type
export const AuditRecord = Schema.Struct({ id: AuditId, clientId: Schema.NullOr(ClientId), alias: Schema.NullOr(Alias), tool: Schema.NullOr(ToolName), connection: Schema.NullOr(ConnectionRef), subject: Schema.NullOr(SubjectId), decision: Schema.NullOr(PolicyDecision), outcome: AuditOutcome, message: Schema.NullOr(Schema.String), createdAt: Schema.Date })
export type AuditRecord = typeof AuditRecord.Type
export const ConfigureClient = Schema.Struct({ name: Schema.String.check(Schema.isMinLength(1)), tools: Schema.Array(Schema.Struct({ connection: ConnectionRef, tool: ToolName, decision: PolicyDecision })).check(Schema.isMinLength(1)) })
export type ConfigureClient = typeof ConfigureClient.Type
export const ToolSnapshot = Schema.Struct({ integration: IntegrationSlug, connection: ConnectionName, tool: ToolName, inputSchema: Schema.NullOr(Schema.Json), outputSchema: Schema.NullOr(Schema.Json), syncedAt: Schema.Date })
export type ToolSnapshot = typeof ToolSnapshot.Type
export const DriftKind = Schema.Literals(["added", "removed", "changed"])
export type DriftKind = typeof DriftKind.Type
export const DriftEntry = Schema.Struct({ kind: DriftKind, integration: IntegrationSlug, connection: ConnectionName, tool: ToolName })
export type DriftEntry = typeof DriftEntry.Type

const unknownKeyMessage = "This API key is not known to the server"
const keyRevokedMessage = "This API key was revoked"
const clientRevokedMessage = "The client this key belongs to was revoked"
const notPermittedMessage = "This credential does not hold the required permission"
const crossSiteMessage = "Cross-site requests are not permitted"
export const UnknownKey = Schema.Struct({ code: Schema.Literal("unknown-key"), message: Schema.Literal(unknownKeyMessage) })
export const KeyRevoked = Schema.Struct({ code: Schema.Literal("key-revoked"), message: Schema.Literal(keyRevokedMessage) })
export const ClientRevoked = Schema.Struct({ code: Schema.Literal("client-revoked"), message: Schema.Literal(clientRevokedMessage) })
export const NotPermitted = Schema.Struct({ code: Schema.Literal("not-permitted"), message: Schema.Literal(notPermittedMessage) })
export const CrossSite = Schema.Struct({ code: Schema.Literal("cross-site"), message: Schema.Literal(crossSiteMessage) })
export const RefusalReason = Schema.Union([UnknownKey, KeyRevoked, ClientRevoked, NotPermitted, CrossSite])
export type RefusalReason = typeof RefusalReason.Type
export const refusalReason = (code: RefusalReason["code"]): RefusalReason => {
  switch (code) {
    case "unknown-key": return { code, message: unknownKeyMessage }
    case "key-revoked": return { code, message: keyRevokedMessage }
    case "client-revoked": return { code, message: clientRevokedMessage }
    case "not-permitted": return { code, message: notPermittedMessage }
    case "cross-site": return { code, message: crossSiteMessage }
  }
}

export { Alias, ApprovalStatus, ConnectionName, IntegrationSlug, OwnerTier, ToolName }
