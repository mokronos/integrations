import { Schema } from "effect"
export * from "@integrations/contracts"
export {
  Alias, ApprovalStatus, ConnectionName, IntegrationSlug, ToolName, TenantId, SubjectId, ClientId,
  ApiKeyId, ApiKeyView, AccessProfileId, ApprovalPolicyId, ApprovalId, ApprovalDestinationId,
  ApprovalDeliveryId, AuditId, ConnectionRef, connectionSubject, connectionRefKey,
  sameConnectionRef, aliasForConnection, ClientCapability, ApprovalDelivery, ApprovalDestination,
  ApprovalDeliveryStatus, ApprovalDeliveryAttempt, Client, PolicyDecision, AccessProfile,
  AccessProfileTool, ApprovalPolicy, ApprovalPolicyTool, PendingApproval, AuditOutcome,
  AuditRecord, ConfigureClient, ToolSnapshot, DriftKind, DriftEntry
} from "@integrations/contracts"
import { TenantId, SubjectId, ClientId, Client, ClientCapability, ApprovalDelivery, Alias, ConnectionRef, AccessProfile, AccessProfileTool, ApprovalPolicy, ApprovalPolicyTool, PolicyDecision, ToolName, ApiKeyId } from "@integrations/contracts"
export const ApiKeyHash = Schema.String.pipe(Schema.brand("ApiKeyHash"))
export type ApiKeyHash = typeof ApiKeyHash.Type
export const ApiKey = Schema.Struct({ id: ApiKeyId, clientId: ClientId, hash: ApiKeyHash, createdAt: Schema.Date, lastUsedAt: Schema.NullOr(Schema.Date), revokedAt: Schema.NullOr(Schema.Date) })
export type ApiKey = typeof ApiKey.Type
export const SessionTokenHash = Schema.String.pipe(Schema.brand("SessionTokenHash"))
export type SessionTokenHash = typeof SessionTokenHash.Type
export const LoginHandoffHash = Schema.String.pipe(Schema.brand("LoginHandoffHash"))
export type LoginHandoffHash = typeof LoginHandoffHash.Type
export const defaultTenantId = TenantId.make("default")
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
export const defaultApprovalDelivery: ApprovalDelivery = { returnLink: true }
export const clientHasCapability = (client: Client, capability: ClientCapability): boolean => client.capabilities.includes(capability)
export const Authorized = Schema.Struct({ status: Schema.Literal("authorized"), client: Client, accessProfile: AccessProfile, accessProfileTool: AccessProfileTool, approvalPolicy: ApprovalPolicy, approvalPolicyTool: ApprovalPolicyTool, alias: Alias, connection: ConnectionRef, subject: Schema.NullOr(SubjectId), decision: PolicyDecision })
export type Authorized = typeof Authorized.Type
export const AuthorizationUnknownKey = Schema.Struct({ status: Schema.Literal("unknown-key"), message: Schema.Literal("This API key is not known to the server") })
export const AuthorizationKeyRevoked = Schema.Struct({ status: Schema.Literal("key-revoked"), message: Schema.Literal("This API key was revoked") })
export const AuthorizationClientRevoked = Schema.Struct({ status: Schema.Literal("client-revoked"), message: Schema.Literal("The client this key belongs to was revoked") })
export const NotAuthorized = Schema.Struct({ status: Schema.Literal("not-authorized"), alias: Alias, tool: ToolName, message: Schema.String })
export const AuthorizationDenied = Schema.Union([AuthorizationUnknownKey, AuthorizationKeyRevoked, AuthorizationClientRevoked, NotAuthorized])
export type AuthorizationDenied = typeof AuthorizationDenied.Type
export const Authorization = Schema.Union([Authorized, AuthorizationDenied])
export type Authorization = typeof Authorization.Type
const isJsonObject = Schema.is(Schema.Record(Schema.String, Schema.Json))
const canonicalise = (value: Schema.Json): Schema.Json => {
  if (Array.isArray(value)) return value.map(canonicalise)
  if (isJsonObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalise(nested)])
    )
  }
  return value
}
export const canonicalArguments = (value: Schema.Json): string => JSON.stringify(canonicalise(value))
