import { Schema } from "effect"
import { Alias, ApprovalStatus, ConnectionName, ConnectionOwner, IntegrationSlug, ToolName } from "./vocabulary.ts"
import { OAuthSessionView } from "./oauth.ts"
import { ArgumentPattern } from "./argument-paths.ts"

export const TenantId = Schema.String.pipe(Schema.brand("TenantId"))
export type TenantId = typeof TenantId.Type
/** A person the gateway acts for. Ids double as a segment of connection owners and tool addresses, hence the alphabet. */
export const SubjectId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/)).pipe(Schema.brand("SubjectId"))
export type SubjectId = typeof SubjectId.Type
export const ProfileId = Schema.String.pipe(Schema.brand("ProfileId"))
export type ProfileId = typeof ProfileId.Type
export const ApiKeyId = Schema.String.pipe(Schema.brand("ApiKeyId"))
export type ApiKeyId = typeof ApiKeyId.Type
export const ApprovalId = Schema.String.pipe(Schema.brand("ApprovalId"))
export type ApprovalId = typeof ApprovalId.Type
export const ApprovalRuleId = Schema.String.pipe(Schema.brand("ApprovalRuleId"))
export type ApprovalRuleId = typeof ApprovalRuleId.Type
export const ApprovalDestinationId = Schema.String.pipe(Schema.brand("ApprovalDestinationId"))
export type ApprovalDestinationId = typeof ApprovalDestinationId.Type
export const ApprovalDeliveryId = Schema.String.pipe(Schema.brand("ApprovalDeliveryId"))
export type ApprovalDeliveryId = typeof ApprovalDeliveryId.Type
export const AuditId = Schema.String.pipe(Schema.brand("AuditId"))
export type AuditId = typeof AuditId.Type
export const OAuthApplicationId = Schema.String.pipe(Schema.brand("OAuthApplicationId"))
export type OAuthApplicationId = typeof OAuthApplicationId.Type
export const OAuthGrantId = Schema.String.pipe(Schema.brand("OAuthGrantId"))
export type OAuthGrantId = typeof OAuthGrantId.Type

/**
 * A connection as policy names it. A user-owned reference without a subject is
 * a delegation template: it stands for "the calling user's own connection" and
 * resolves to a concrete one when an invocation names its subject.
 */
export const ConnectionRef = Schema.Union([
  Schema.Struct({ owner: Schema.Literal("org"), integration: IntegrationSlug, name: ConnectionName }),
  Schema.Struct({ owner: Schema.Literal("user"), subject: Schema.optional(SubjectId), integration: IntegrationSlug, name: ConnectionName })
])
export type ConnectionRef = typeof ConnectionRef.Type
export const connectionSubject = (connection: ConnectionRef): SubjectId | undefined => connection.owner === "user" ? connection.subject : undefined
export const isDelegationTemplate = (connection: ConnectionRef): boolean => connection.owner === "user" && connection.subject === undefined
/** The owner key the integration host files this connection under. */
export const connectionOwner = (connection: ConnectionRef): ConnectionOwner => connection.owner === "org" ? "org" : `user:${connection.subject ?? ""}`
export const userOwner = (subject: SubjectId): ConnectionOwner => `user:${subject}`
const userOwnerPrefix = "user:"
/** The reference for a connection the integration host holds. */
export const connectionRefOf = (owner: ConnectionOwner, integration: IntegrationSlug, name: ConnectionName): ConnectionRef =>
  owner === "org"
    ? { owner: "org", integration, name }
    : { owner: "user", subject: SubjectId.make(owner.slice(userOwnerPrefix.length)), integration, name }
/** The template with the subject removed, which is how policy names a delegated tool. */
export const delegationTemplateOf = (connection: ConnectionRef): ConnectionRef =>
  connection.owner === "org" ? connection : { owner: "user", integration: connection.integration, name: connection.name }
export const connectionRefKey = (connection: ConnectionRef): string => [connection.owner, connectionSubject(connection) ?? "", connection.integration, connection.name].join("\u0000")
export const sameConnectionRef = (left: ConnectionRef, right: ConnectionRef): boolean => connectionRefKey(left) === connectionRefKey(right)
const utf8 = new TextEncoder()
/**
 * Segments are joined by three underscores, so each one keeps its own runs to
 * at most two and the joiner stays unambiguous. Slugs already arrive with
 * single internal separators, so a `_` is carried through as itself and only
 * `-` has to widen; that keeps the readable part of a name readable.
 */
const aliasJoiner = "___"
const aliasSlugPart = (value: string): string => value.replaceAll("-", "__")
/** Subject ids come from an identity provider, so nothing about them is assumed. */
const aliasSubjectPart = (value: string): string => Array.from(utf8.encode(value), (byte) => byte >= 0x61 && byte <= 0x7a || byte >= 0x30 && byte <= 0x39 ? String.fromCharCode(byte) : `__${byte.toString(16).padStart(2, "0")}`).join("")
export const aliasForConnection = (connection: ConnectionRef): Alias => Alias.make([connection.owner, ...connection.owner === "user" && connection.subject !== undefined ? [aliasSubjectPart(connection.subject)] : [], aliasSlugPart(connection.integration), aliasSlugPart(connection.name)].join(aliasJoiner))

export const ProfileCapability = Schema.Literals(["provision_connections", "administer_gateway"])
export type ProfileCapability = typeof ProfileCapability.Type
export const ApprovalMethod = Schema.Literals(["elicitation", "link", "none"])
export type ApprovalMethod = typeof ApprovalMethod.Type
export const McpSurface = Schema.Literals(["tools", "discovery"])
export type McpSurface = typeof McpSurface.Type
/** How a profile treats one enabled tool. A tool that is off has no decision at all. */
export const ToolDecision = Schema.Literals(["allow", "require_approval"])
export type ToolDecision = typeof ToolDecision.Type

/** Minutes after a group's first call during which calls to the same tool join it; 0 turns grouping off. */
export const ApprovalGroupWindowMinutes = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1440 }))
export type ApprovalGroupWindowMinutes = typeof ApprovalGroupWindowMinutes.Type
export const defaultApprovalGroupWindowMinutes = 30

/**
 * What a set of AI apps may do through the gateway: its tools, how each is
 * decided, and how approvals reach a human. Every app connects with its own
 * key or OAuth grant, so calls stay attributable and revocable one by one.
 */
export const Profile = Schema.Struct({
  id: ProfileId, tenantId: TenantId,
  name: Schema.String, capabilities: Schema.Array(ProfileCapability), approvalMethod: ApprovalMethod, mcpSurface: McpSurface,
  approvalGroupWindowMinutes: ApprovalGroupWindowMinutes,
  /** Tools of newly connected services are enabled with their default decision. */
  includeNewTools: Schema.Boolean,
  createdAt: Schema.Date, revokedAt: Schema.NullOr(Schema.Date)
})
export type Profile = typeof Profile.Type

export const ApiKeyView = Schema.Struct({ id: ApiKeyId, profileId: ProfileId, name: Schema.String, createdAt: Schema.Date, lastUsedAt: Schema.NullOr(Schema.Date), revokedAt: Schema.NullOr(Schema.Date) })
export type ApiKeyView = typeof ApiKeyView.Type

export const ProfileTool = Schema.Struct({ profileId: ProfileId, connection: ConnectionRef, tool: ToolName, decision: ToolDecision })
export type ProfileTool = typeof ProfileTool.Type

/** The credential a call arrived with, and what the calling app said about itself. */
export const Caller = Schema.Struct({
  apiKeyId: Schema.NullOr(ApiKeyId),
  oauthGrantId: Schema.NullOr(OAuthGrantId),
  oauthApplicationId: Schema.NullOr(OAuthApplicationId),
  /** The key's or OAuth application's name when the call was made. */
  credentialName: Schema.NullOr(Schema.String),
  /** Self-reported, such as an MCP client's name and version. */
  agent: Schema.NullOr(Schema.String)
})
export type Caller = typeof Caller.Type

export const ApprovalDestination = Schema.Struct({ id: ApprovalDestinationId, tenantId: TenantId, name: Schema.String, type: Schema.Literal("webhook"), url: Schema.String.check(Schema.isPattern(/^https:\/\/[^\s]+$/)), createdAt: Schema.Date })
export type ApprovalDestination = typeof ApprovalDestination.Type
export const ApprovalDeliveryStatus = Schema.Literals(["pending", "retrying", "delivered", "failed"])
export type ApprovalDeliveryStatus = typeof ApprovalDeliveryStatus.Type
export const ApprovalDeliveryAttempt = Schema.Struct({ id: ApprovalDeliveryId, approvalId: ApprovalId, destinationId: ApprovalDestinationId, destinationName: Schema.String, status: ApprovalDeliveryStatus, attempts: Schema.Number, nextAttemptAt: Schema.NullOr(Schema.Date), deliveredAt: Schema.NullOr(Schema.Date), lastError: Schema.NullOr(Schema.String) })
export type ApprovalDeliveryAttempt = typeof ApprovalDeliveryAttempt.Type

export const PendingApproval = Schema.Struct({ id: ApprovalId, groupId: ApprovalId, profileId: ProfileId, caller: Caller, alias: Schema.String, tool: ToolName, arguments: Schema.Json, status: ApprovalStatus, createdAt: Schema.Date, expiresAt: Schema.Date, decidedAt: Schema.NullOr(Schema.Date), decidedBy: Schema.NullOr(Schema.String), result: Schema.NullOr(Schema.Json), error: Schema.NullOr(Schema.String), collectedAt: Schema.NullOr(Schema.Date) })
export type PendingApproval = typeof PendingApproval.Type
export const ListedApproval = Schema.Struct({ ...PendingApproval.fields, deliveries: Schema.Array(ApprovalDeliveryAttempt) })
export type ListedApproval = typeof ListedApproval.Type
export const ApprovalRule = Schema.Struct({
  id: ApprovalRuleId, profileId: ProfileId, connection: ConnectionRef, tool: ToolName,
  ...ArgumentPattern.fields, createdAt: Schema.Date, createdBy: Schema.NullOr(Schema.String)
})
export type ApprovalRule = typeof ApprovalRule.Type
export const ApprovalVerdict = Schema.Literals(["approve", "deny"])
export type ApprovalVerdict = typeof ApprovalVerdict.Type
export const DecidedApproval = Schema.Union([
  Schema.Struct({ id: ApprovalId, status: Schema.Literal("decided"), approval: PendingApproval }),
  Schema.Struct({ id: ApprovalId, status: Schema.Literal("refused"), error: Schema.String })
])
export type DecidedApproval = typeof DecidedApproval.Type

/** What changed, so a dashboard knows which of its views to reload. */
export const GatewayResource = Schema.Literals(["approvals", "audit", "profiles", "approval-destinations", "integrations"])
export type GatewayResource = typeof GatewayResource.Type
export const GatewayEvent = Schema.Union([
  Schema.TaggedStruct("Connected", {}),
  Schema.TaggedStruct("Heartbeat", {}),
  Schema.TaggedStruct("Changed", { resource: GatewayResource })
])
export type GatewayEvent = typeof GatewayEvent.Type
export const InvocationSucceeded = Schema.Struct({ status: Schema.Literal("succeeded"), result: Schema.Json })
export type InvocationSucceeded = typeof InvocationSucceeded.Type
export const InvocationPending = Schema.Struct({ status: Schema.Literal("pending"), approvalId: ApprovalId, expiresAt: Schema.Date, approvalUrl: Schema.optional(Schema.String) })
export type InvocationPending = typeof InvocationPending.Type
export const InvocationDenied = Schema.Struct({ status: Schema.Literal("denied"), reason: Schema.String })
export type InvocationDenied = typeof InvocationDenied.Type
export const InvocationFailed = Schema.Struct({ status: Schema.Literal("failed"), message: Schema.String })
export type InvocationFailed = typeof InvocationFailed.Type
export const InvocationIssue = Schema.Struct({ path: Schema.String, message: Schema.String })
export const InvocationInvalid = Schema.Struct({ status: Schema.Literal("invalid"), message: Schema.String, issues: Schema.Array(InvocationIssue) })
export type InvocationInvalid = typeof InvocationInvalid.Type
/** The tool acts for a user who has not connected yet: the flow is started, bound to them, and waits for their browser. */
export const InvocationAuthorizationRequired = Schema.Struct({
  status: Schema.Literal("authorization-required"),
  integration: IntegrationSlug,
  connection: ConnectionName,
  subject: SubjectId,
  session: OAuthSessionView
})
export type InvocationAuthorizationRequired = typeof InvocationAuthorizationRequired.Type
export const InvocationOutcome = Schema.Union([InvocationSucceeded, InvocationPending, InvocationDenied, InvocationFailed, InvocationInvalid, InvocationAuthorizationRequired])
export type InvocationOutcome = typeof InvocationOutcome.Type
export const AuditOutcome = Schema.Literals(["succeeded", "failed", "denied", "pending"])
export type AuditOutcome = typeof AuditOutcome.Type
/** How a call that asked got to run: a human approved it once, approved it and saved the pattern, or a saved approval matched. */
export const AuditApproval = Schema.Literals(["approved", "approved_always", "saved_approval"])
export type AuditApproval = typeof AuditApproval.Type
export const AuditRecord = Schema.Struct({ id: AuditId, profileId: Schema.NullOr(ProfileId), caller: Caller, authorizedBySubjectId: Schema.NullOr(SubjectId), alias: Schema.NullOr(Schema.String), tool: Schema.NullOr(ToolName), connection: Schema.NullOr(ConnectionRef), subject: Schema.NullOr(SubjectId), decision: Schema.NullOr(ToolDecision), approval: Schema.NullOr(AuditApproval), outcome: AuditOutcome, message: Schema.NullOr(Schema.String), createdAt: Schema.Date })
export type AuditRecord = typeof AuditRecord.Type

export const OAuthApplicationKind = Schema.Literals(["cimd", "dcr"])
export type OAuthApplicationKind = typeof OAuthApplicationKind.Type
export const OAuthGrantView = Schema.Struct({
  id: OAuthGrantId,
  applicationId: OAuthApplicationId,
  applicationKind: OAuthApplicationKind,
  applicationName: Schema.String,
  profileId: ProfileId,
  profileName: Schema.String,
  subjectId: SubjectId,
  subjectEmail: Schema.String,
  scope: Schema.Literal("mcp"),
  createdAt: Schema.Date,
  lastUsedAt: Schema.NullOr(Schema.Date),
  revokedAt: Schema.NullOr(Schema.Date)
})
export type OAuthGrantView = typeof OAuthGrantView.Type
export const OAuthConsentView = Schema.Struct({
  request: Schema.Struct({ id: Schema.String, scope: Schema.Literal("mcp"), resource: Schema.String }),
  application: Schema.Struct({
    id: OAuthApplicationId,
    kind: OAuthApplicationKind,
    name: Schema.String,
    clientIdentifier: Schema.String
  }),
  profiles: Schema.Array(Profile)
})
export type OAuthConsentView = typeof OAuthConsentView.Type
export const OAuthConsentDecision = Schema.Union([
  Schema.Struct({ decision: Schema.Literal("deny") }),
  Schema.Struct({ decision: Schema.Literal("approve"), profileId: ProfileId })
])
export type OAuthConsentDecision = typeof OAuthConsentDecision.Type
export const ProfileToolInput = Schema.Struct({ connection: ConnectionRef, tool: ToolName, decision: ToolDecision })
export type ProfileToolInput = typeof ProfileToolInput.Type
export const ToolSnapshot = Schema.Struct({ integration: IntegrationSlug, connection: ConnectionName, tool: ToolName, inputSchema: Schema.NullOr(Schema.Json), outputSchema: Schema.NullOr(Schema.Json), syncedAt: Schema.Date })
export type ToolSnapshot = typeof ToolSnapshot.Type
export const DriftKind = Schema.Literals(["added", "removed", "changed"])
export type DriftKind = typeof DriftKind.Type
export const DriftEntry = Schema.Struct({ kind: DriftKind, integration: IntegrationSlug, connection: ConnectionName, tool: ToolName })
export type DriftEntry = typeof DriftEntry.Type

const unknownKeyMessage = "This API key is not known to the server"
const keyRevokedMessage = "This API key was revoked"
const profileRevokedMessage = "The profile this credential belongs to was revoked"
const notPermittedMessage = "This credential does not hold the required permission"
const crossSiteMessage = "Cross-site requests are not permitted"
export const UnknownKey = Schema.Struct({ code: Schema.Literal("unknown-key"), message: Schema.Literal(unknownKeyMessage) })
export const KeyRevoked = Schema.Struct({ code: Schema.Literal("key-revoked"), message: Schema.Literal(keyRevokedMessage) })
export const ProfileRevoked = Schema.Struct({ code: Schema.Literal("profile-revoked"), message: Schema.Literal(profileRevokedMessage) })
export const NotPermitted = Schema.Struct({ code: Schema.Literal("not-permitted"), message: Schema.Literal(notPermittedMessage) })
export const CrossSite = Schema.Struct({ code: Schema.Literal("cross-site"), message: Schema.Literal(crossSiteMessage) })
export const RefusalReason = Schema.Union([UnknownKey, KeyRevoked, ProfileRevoked, NotPermitted, CrossSite])
export type RefusalReason = typeof RefusalReason.Type
export const refusalReason = (code: RefusalReason["code"]): RefusalReason => {
  switch (code) {
    case "unknown-key": return { code, message: unknownKeyMessage }
    case "key-revoked": return { code, message: keyRevokedMessage }
    case "profile-revoked": return { code, message: profileRevokedMessage }
    case "not-permitted": return { code, message: notPermittedMessage }
    case "cross-site": return { code, message: crossSiteMessage }
  }
}

export { Alias, ApprovalStatus, ConnectionName, IntegrationSlug, ConnectionOwner, ToolName }
