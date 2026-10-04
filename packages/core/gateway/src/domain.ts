import { Schema } from "effect"
export * from "@integragents/contracts"
export {
  Alias, ApprovalStatus, ConnectionName, IntegrationSlug, ToolName, TenantId, SubjectId, ProfileId,
  ApiKeyId, ApiKeyView, ApprovalId, ApprovalDestinationId,
  ApprovalDeliveryId, AuditId, ConnectionRef, connectionSubject, connectionRefKey,
  OAuthApplicationId, OAuthGrantId, OAuthApplicationKind, OAuthGrantView,
  sameConnectionRef, aliasForConnection, ProfileCapability, ApprovalMethod, McpSurface, ApprovalDestination,
  ApprovalDeliveryStatus, ApprovalDeliveryAttempt, Profile, ToolDecision, ProfileTool, ProfileToolInput,
  Caller, PendingApproval, AuditApproval, AuditOutcome, AuditRecord, ToolSnapshot, DriftKind, DriftEntry
} from "@integragents/contracts"
import { TenantId, SubjectId, ProfileId, Profile, ProfileCapability, ApprovalMethod, Alias, ConnectionRef, ProfileTool, ToolDecision, ToolName, ApiKeyId } from "@integragents/contracts"
import type { Caller } from "@integragents/contracts"
import type { OAuthActor } from "./mcp-oauth.ts"
export const ApiKeyHash = Schema.String.pipe(Schema.brand("ApiKeyHash"))
export type ApiKeyHash = typeof ApiKeyHash.Type
export const ApiKey = Schema.Struct({ id: ApiKeyId, profileId: ProfileId, name: Schema.String, hash: ApiKeyHash, createdAt: Schema.Date, lastUsedAt: Schema.NullOr(Schema.Date), revokedAt: Schema.NullOr(Schema.Date) })
export type ApiKey = typeof ApiKey.Type
export const SessionTokenHash = Schema.String.pipe(Schema.brand("SessionTokenHash"))
export type SessionTokenHash = typeof SessionTokenHash.Type
export const LoginHandoffHash = Schema.String.pipe(Schema.brand("LoginHandoffHash"))
export type LoginHandoffHash = typeof LoginHandoffHash.Type
export const defaultTenantId = TenantId.make("default")
export const defaultLocalSubjectId = SubjectId.make("local-operator")
export const Tenant = Schema.Struct({ id: TenantId, name: Schema.String, createdAt: Schema.Date })
export type Tenant = typeof Tenant.Type
export const Subject = Schema.Struct({ id: SubjectId, tenantId: TenantId, createdAt: Schema.Date })
export type Subject = typeof Subject.Type
export const Login = Schema.Struct({ subjectId: SubjectId, tenantId: TenantId, email: Schema.String, createdAt: Schema.Date })
export type Login = typeof Login.Type
export const AuthSession = Schema.Struct({ tokenHash: SessionTokenHash, tenantId: TenantId, subjectId: SubjectId, email: Schema.String, createdAt: Schema.Date, expiresAt: Schema.Date })
export type AuthSession = typeof AuthSession.Type
export const IdentityProvider = Schema.Literal("google")
export type IdentityProvider = typeof IdentityProvider.Type
export const ExternalIdentity = Schema.Struct({ provider: IdentityProvider, providerSubject: Schema.String, tenantId: TenantId, subjectId: SubjectId, email: Schema.String, createdAt: Schema.Date })
export type ExternalIdentity = typeof ExternalIdentity.Type
export const LoginHandoff = Schema.Struct({ requestHash: LoginHandoffHash, subjectId: Schema.NullOr(SubjectId), tenantId: Schema.NullOr(TenantId), email: Schema.NullOr(Schema.String), createdAt: Schema.Date, expiresAt: Schema.Date, collectedAt: Schema.NullOr(Schema.Date) })
export type LoginHandoff = typeof LoginHandoff.Type
export const defaultApprovalMethod: ApprovalMethod = "elicitation"
export const profileHasCapability = (profile: Profile, capability: ProfileCapability): boolean => profile.capabilities.includes(capability)
export const Authorized = Schema.Struct({ status: Schema.Literal("authorized"), profile: Profile, profileTool: ProfileTool, alias: Alias, connection: ConnectionRef, subject: Schema.NullOr(SubjectId), decision: ToolDecision })
export type Authorized = typeof Authorized.Type
export const AuthorizationUnknownKey = Schema.Struct({ status: Schema.Literal("unknown-key"), message: Schema.Literal("This API key is not known to the server") })
export const AuthorizationKeyRevoked = Schema.Struct({ status: Schema.Literal("key-revoked"), message: Schema.Literal("This API key was revoked") })
export const AuthorizationProfileRevoked = Schema.Struct({ status: Schema.Literal("profile-revoked"), message: Schema.Literal("The profile this credential belongs to was revoked") })
export const NotAuthorized = Schema.Struct({ status: Schema.Literal("not-authorized"), alias: Alias, tool: ToolName, message: Schema.String })
export const AuthorizationDenied = Schema.Union([AuthorizationUnknownKey, AuthorizationKeyRevoked, AuthorizationProfileRevoked, NotAuthorized])
export type AuthorizationDenied = typeof AuthorizationDenied.Type
export const Authorization = Schema.Union([Authorized, AuthorizationDenied])
export type Authorization = typeof Authorization.Type

/** Who made a call: the credential and app behind it, and the person who authorized an OAuth app. */
export interface CallOrigin {
  readonly caller: Caller
  readonly authorizedBy: SubjectId | null
}
export const unattributedOrigin: CallOrigin = {
  caller: { apiKeyId: null, oauthGrantId: null, oauthApplicationId: null, credentialName: null, agent: null },
  authorizedBy: null
}
export const keyOrigin = (key: ApiKey, agent?: string): CallOrigin => ({
  caller: { apiKeyId: key.id, oauthGrantId: null, oauthApplicationId: null, credentialName: key.name, agent: agent ?? null },
  authorizedBy: null
})
export const oauthOrigin = (actor: OAuthActor, agent?: string): CallOrigin => ({
  caller: {
    apiKeyId: null,
    oauthGrantId: actor.grantId,
    oauthApplicationId: actor.applicationId,
    credentialName: actor.applicationName,
    agent: agent ?? null
  },
  authorizedBy: actor.subjectId
})
