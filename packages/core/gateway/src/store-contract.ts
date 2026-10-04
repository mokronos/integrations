import { Effect, Schema } from "effect"
import type { NonNegativeInt, PositiveInt } from "@integragents/contracts"
import type {
  Alias, ApiKey, ApiKeyHash,
  ApiKeyId, ApprovalGroupWindowMinutes, ApprovalMethod, ApprovalDeliveryAttempt, ApprovalDeliveryId, McpSurface,
  ApprovalDestination, ApprovalDestinationId, ApprovalId,
  ApprovalRule, ApprovalRuleId, ApprovalStatus, ArgumentPattern, AuditId, AuditOutcome, AuditRecord,
  AuthSession, Caller, ConnectionName, ConnectionRef,
  ExternalIdentity, IdentityProvider, IntegrationSlug, Login, LoginHandoff,
  LoginHandoffHash, PendingApproval, Profile, ProfileCapability, ProfileId, ProfileTool, ProfileToolInput,
  SessionTokenHash, Subject, SubjectId, Tenant, TenantId, ToolDecision, ToolName, ToolSnapshot,
  OAuthApplicationId, OAuthGrantId, OAuthGrantView
} from "./domain.ts"
import type { PasswordHash } from "./passwords.ts"
import type {
  OAuthActor, OAuthApplication, OAuthAuthorizationCode, OAuthAuthorizationRequest,
  OAuthGrant, OAuthSecretHash, OAuthToken
} from "./mcp-oauth.ts"

export interface CreateTenantInput {
  readonly id?: TenantId
  readonly name: string
}

export interface CreateSubjectInput {
  readonly id: SubjectId
  readonly tenantId: TenantId
}

export interface LoginRecord extends Login {
  readonly passwordHash: PasswordHash | null
}

export interface IdentityOAuthStateRecord {
  readonly stateHash: LoginHandoffHash
  readonly provider: IdentityProvider
  readonly handoffHash: LoginHandoffHash | null
  readonly returnPath: string | null
  readonly expiresAt: Date
}

export interface CreateProfileInput {
  readonly tenantId: TenantId
  readonly id: ProfileId
  readonly name: string
  readonly capabilities: ReadonlyArray<ProfileCapability>
  readonly approvalMethod?: ApprovalMethod
  readonly mcpSurface?: McpSurface
  readonly approvalGroupWindowMinutes?: ApprovalGroupWindowMinutes
  readonly includeNewTools?: boolean
  readonly tools: ReadonlyArray<ProfileToolInput>
  readonly destinationIds?: ReadonlyArray<ApprovalDestinationId>
}

export interface ProfileSettings {
  readonly capabilities: ReadonlyArray<ProfileCapability>
  readonly approvalMethod: ApprovalMethod
  readonly mcpSurface: McpSurface
  readonly approvalGroupWindowMinutes: ApprovalGroupWindowMinutes
  readonly includeNewTools: boolean
}

export interface CreateApprovalInput {
  readonly tenantId: TenantId
  readonly id: ApprovalId
  readonly profileId: ProfileId
  readonly caller: Caller
  readonly alias: Alias
  readonly tool: ToolName
  readonly arguments: typeof Schema.Json.Type
  readonly expiresAt: Date
  /** Joins the newest open group for this tool whose first call is younger than this. */
  readonly groupWindowMinutes: ApprovalGroupWindowMinutes
}

export interface ApprovalDeliveryJob extends ApprovalDeliveryAttempt {
  readonly tenantId: TenantId
  readonly groupId: ApprovalId
  readonly profileId: ProfileId
  readonly profileName: string
  readonly alias: Alias
  readonly tool: ToolName
  readonly expiresAt: Date
  readonly url: string
  readonly signingSecret: string
}

export interface AuditQuery {
  readonly limit?: PositiveInt
  readonly offset?: NonNegativeInt
  readonly profileId?: ProfileId
  readonly alias?: Alias
  readonly tool?: ToolName
  readonly outcome?: AuditOutcome
  readonly since?: Date
}

export interface RecordAuditInput {
  readonly tenantId: TenantId
  readonly id: AuditId
  readonly profileId: ProfileId | null
  readonly caller: Caller
  readonly authorizedBySubjectId: SubjectId | null
  readonly alias: Alias | null
  readonly tool: ToolName | null
  readonly connection: ConnectionRef | null
  readonly decision: ToolDecision | null
  readonly outcome: AuditOutcome
  readonly message: string | null
  readonly arguments?: {
    readonly value: typeof Schema.Json.Type
    readonly expiresAt: Date
  }
}

export interface GatewayOverviewCounts {
  readonly profiles: number
  readonly profileTools: number
  readonly keys: number
  readonly pendingApprovals: number
}

/**
 * Everything the gateway keeps. Each member answers with an Effect: the store
 * runs on a SqlClient, so there is no promise boundary to lift over.
 */
export interface GatewayStore {

  createTenant(input?: CreateTenantInput): Effect.Effect<Tenant, GatewayStoreError>
  listTenants(): Effect.Effect<ReadonlyArray<Tenant>, GatewayStoreError>
  findTenantById(id: TenantId): Effect.Effect<Tenant | undefined, GatewayStoreError>
  findTenantByName(name: string): Effect.Effect<Tenant | undefined, GatewayStoreError>

  createSubject(input: CreateSubjectInput): Effect.Effect<Subject, GatewayStoreError>
  listSubjects(tenantId: TenantId): Effect.Effect<ReadonlyArray<Subject>, GatewayStoreError>
  countSubjects(tenantId: TenantId): Effect.Effect<number, GatewayStoreError>
  findSubjectById(id: SubjectId): Effect.Effect<Subject | undefined, GatewayStoreError>

  createLogin(input: {
    readonly subjectId: SubjectId
    readonly tenantId: TenantId
    readonly email: string
    readonly passwordHash: PasswordHash | null
  }): Effect.Effect<LoginRecord, GatewayStoreError>
  findLoginByEmail(email: string): Effect.Effect<LoginRecord | undefined, GatewayStoreError>
  findLoginBySubject(subjectId: SubjectId): Effect.Effect<LoginRecord | undefined, GatewayStoreError>
  countLogins(): Effect.Effect<number, GatewayStoreError>
  changeLoginEmail(subjectId: SubjectId, email: string): Effect.Effect<void, GatewayStoreError>
  changeLoginPassword(subjectId: SubjectId, passwordHash: string): Effect.Effect<void, GatewayStoreError>
  deleteSubject(subjectId: SubjectId): Effect.Effect<void, GatewayStoreError>
  deleteTenant(id: TenantId): Effect.Effect<void, GatewayStoreError>
  revokeSubjectSessions(subjectId: SubjectId, exceptTokenHash?: SessionTokenHash): Effect.Effect<number, GatewayStoreError>

  createSession(input: {
    readonly tokenHash: SessionTokenHash
    readonly subjectId: SubjectId
    readonly tenantId: TenantId
    readonly expiresAt: Date
  }): Effect.Effect<AuthSession, GatewayStoreError>
  findLiveSession(tokenHash: SessionTokenHash): Effect.Effect<AuthSession | undefined, GatewayStoreError>
  revokeSession(tokenHash: SessionTokenHash): Effect.Effect<void, GatewayStoreError>
  deleteExpiredSessions(now: Date): Effect.Effect<number, GatewayStoreError>

  createExternalIdentity(input: {
    readonly provider: IdentityProvider
    readonly providerSubject: string
    readonly subjectId: SubjectId
    readonly tenantId: TenantId
    readonly email: string
  }): Effect.Effect<ExternalIdentity, GatewayStoreError>
  findExternalIdentity(
    provider: IdentityProvider,
    providerSubject: string
  ): Effect.Effect<ExternalIdentity | undefined, GatewayStoreError>
  listExternalIdentities(subjectId: SubjectId): Effect.Effect<ReadonlyArray<ExternalIdentity>, GatewayStoreError>

  createLoginHandoff(input: {
    readonly requestHash: LoginHandoffHash
    readonly expiresAt: Date
  }): Effect.Effect<LoginHandoff, GatewayStoreError>
  getLoginHandoff(requestHash: LoginHandoffHash): Effect.Effect<LoginHandoff | undefined, GatewayStoreError>
  completeLoginHandoff(input: {
    readonly requestHash: LoginHandoffHash
    readonly subjectId: SubjectId
    readonly tenantId: TenantId
    readonly email: string
  }): Effect.Effect<boolean, GatewayStoreError>
  collectLoginHandoff(requestHash: LoginHandoffHash): Effect.Effect<boolean, GatewayStoreError>
  createIdentityOAuthState(input: IdentityOAuthStateRecord): Effect.Effect<void, GatewayStoreError>
  consumeIdentityOAuthState(
    stateHash: LoginHandoffHash
  ): Effect.Effect<IdentityOAuthStateRecord | undefined, GatewayStoreError>
  deleteExpiredIdentityFlows(now: Date): Effect.Effect<number, GatewayStoreError>
  deleteExpiredOAuthState(now: Date): Effect.Effect<number, GatewayStoreError>

  createProfile(input: CreateProfileInput): Effect.Effect<Profile, GatewayStoreError>
  listProfiles(tenantId: TenantId): Effect.Effect<ReadonlyArray<Profile>, GatewayStoreError>
  overviewCounts(tenantId: TenantId): Effect.Effect<GatewayOverviewCounts, GatewayStoreError>
  findProfileById(tenantId: TenantId, id: ProfileId): Effect.Effect<Profile | undefined, GatewayStoreError>
  findProfileByName(tenantId: TenantId, name: string): Effect.Effect<Profile | undefined, GatewayStoreError>
  updateProfileSettings(tenantId: TenantId, id: ProfileId, settings: ProfileSettings): Effect.Effect<Profile, GatewayStoreError>
  renameProfile(tenantId: TenantId, id: ProfileId, name: string): Effect.Effect<Profile, GatewayStoreError>
  revokeProfile(tenantId: TenantId, id: ProfileId): Effect.Effect<void, GatewayStoreError>
  listProfileTools(id: ProfileId): Effect.Effect<ReadonlyArray<ProfileTool>, GatewayStoreError>
  replaceProfileTools(id: ProfileId, tools: ReadonlyArray<ProfileToolInput>): Effect.Effect<ReadonlyArray<ProfileTool>, GatewayStoreError>

  createApprovalDestination(input: {
    readonly id: ApprovalDestinationId
    readonly tenantId: TenantId
    readonly name: string
    readonly url: string
    readonly signingSecret: string
  }): Effect.Effect<ApprovalDestination, GatewayStoreError>
  listApprovalDestinations(tenantId: TenantId): Effect.Effect<ReadonlyArray<ApprovalDestination>, GatewayStoreError>
  deleteApprovalDestination(tenantId: TenantId, id: ApprovalDestinationId): Effect.Effect<void, GatewayStoreError>
  listProfileApprovalDestinationIds(profileId: ProfileId): Effect.Effect<ReadonlyArray<ApprovalDestinationId>, GatewayStoreError>
  replaceProfileApprovalDestinations(tenantId: TenantId, profileId: ProfileId, ids: ReadonlyArray<ApprovalDestinationId>): Effect.Effect<ReadonlyArray<ApprovalDestinationId>, GatewayStoreError>
  listApprovalDeliveries(tenantId: TenantId, status?: ApprovalStatus): Effect.Effect<ReadonlyArray<ApprovalDeliveryAttempt>, GatewayStoreError>
  claimDueApprovalDeliveries(now: Date, limit: number): Effect.Effect<ReadonlyArray<ApprovalDeliveryJob>, GatewayStoreError>
  settleApprovalDelivery(input: {
    readonly id: ApprovalDeliveryId
    readonly status: "delivered" | "retrying" | "failed"
    readonly nextAttemptAt: Date | null
    readonly error: string | null
  }): Effect.Effect<void, GatewayStoreError>

  addApiKey(input: { readonly id: ApiKeyId; readonly profileId: ProfileId; readonly name: string; readonly hash: ApiKeyHash }): Effect.Effect<ApiKey, GatewayStoreError>
  listApiKeys(profileId: ProfileId): Effect.Effect<ReadonlyArray<ApiKey>, GatewayStoreError>
  findApiKeyByHash(hash: ApiKeyHash): Effect.Effect<{ readonly key: ApiKey; readonly profile: Profile } | undefined, GatewayStoreError>
  touchApiKey(id: ApiKeyId): Effect.Effect<void, GatewayStoreError>
  revokeApiKey(id: ApiKeyId): Effect.Effect<void, GatewayStoreError>

  upsertOAuthApplication(input: {
    readonly id: OAuthApplicationId
    readonly kind: "cimd" | "dcr"
    readonly clientIdentifier: string
    readonly name: string
    readonly redirectUris: ReadonlyArray<string>
    readonly metadata: typeof Schema.Json.Type
  }): Effect.Effect<OAuthApplication, GatewayStoreError>
  findOAuthApplication(clientIdentifier: string): Effect.Effect<OAuthApplication | undefined, GatewayStoreError>
  findOAuthApplicationById(id: OAuthApplicationId): Effect.Effect<OAuthApplication | undefined, GatewayStoreError>
  createOAuthAuthorizationRequest(input: Omit<OAuthAuthorizationRequest, "createdAt" | "consumedAt">): Effect.Effect<OAuthAuthorizationRequest, GatewayStoreError>
  getOAuthAuthorizationRequest(id: string): Effect.Effect<OAuthAuthorizationRequest | undefined, GatewayStoreError>
  consumeOAuthAuthorizationRequest(id: string): Effect.Effect<OAuthAuthorizationRequest | undefined, GatewayStoreError>
  findOrCreateOAuthGrant(input: {
    readonly id: OAuthGrantId
    readonly applicationId: OAuthApplicationId
    readonly subjectId: SubjectId
    readonly tenantId: TenantId
    readonly profileId: ProfileId
    readonly resource: string
    readonly scope: "mcp"
  }): Effect.Effect<OAuthGrant, GatewayStoreError>
  listOAuthGrants(tenantId: TenantId): Effect.Effect<ReadonlyArray<OAuthGrantView>, GatewayStoreError>
  revokeOAuthGrant(tenantId: TenantId, id: OAuthGrantId): Effect.Effect<boolean, GatewayStoreError>
  createOAuthAuthorizationCode(input: Omit<OAuthAuthorizationCode, "createdAt" | "consumedAt">): Effect.Effect<void, GatewayStoreError>
  consumeOAuthAuthorizationCode(hash: OAuthSecretHash): Effect.Effect<OAuthAuthorizationCode | undefined, GatewayStoreError>
  createOAuthTokens(tokens: ReadonlyArray<Omit<OAuthToken, "createdAt" | "usedAt" | "revokedAt" | "replacedByHash">>): Effect.Effect<void, GatewayStoreError>
  rotateOAuthRefreshToken(input: {
    readonly hash: OAuthSecretHash
    readonly applicationId: OAuthApplicationId
    readonly resource: string
    readonly accessHash: OAuthSecretHash
    readonly refreshHash: OAuthSecretHash
    readonly accessExpiresAt: Date
    readonly refreshExpiresAt: Date
  }): Effect.Effect<OAuthToken | "reused" | undefined, GatewayStoreError>
  resolveOAuthAccessToken(input: {
    readonly hash: OAuthSecretHash
    readonly resource: string
  }): Effect.Effect<{
    readonly profile: Profile
    readonly actor: OAuthActor
    readonly expiresAt: Date
    readonly scope: "mcp"
  } | undefined, GatewayStoreError>

  createApprovalRule(input: {
    readonly id: ApprovalRuleId
    readonly profileId: ProfileId
    readonly connection: ConnectionRef
    readonly tool: ToolName
    readonly pattern: ArgumentPattern
    readonly createdBy: string | null
  }): Effect.Effect<ApprovalRule, GatewayStoreError>
  listApprovalRules(profileId: ProfileId): Effect.Effect<ReadonlyArray<ApprovalRule>, GatewayStoreError>
  findApprovalRule(id: ApprovalRuleId): Effect.Effect<ApprovalRule | undefined, GatewayStoreError>
  updateApprovalRule(id: ApprovalRuleId, pattern: ArgumentPattern): Effect.Effect<ApprovalRule, GatewayStoreError>
  deleteApprovalRule(id: ApprovalRuleId): Effect.Effect<void, GatewayStoreError>

  createApproval(input: CreateApprovalInput): Effect.Effect<PendingApproval, GatewayStoreError>
  getApproval(tenantId: TenantId, id: ApprovalId): Effect.Effect<PendingApproval | undefined, GatewayStoreError>
  listApprovals(tenantId: TenantId, status?: ApprovalStatus): Effect.Effect<ReadonlyArray<PendingApproval>, GatewayStoreError>
  findUncollectedApproval(input: Pick<CreateApprovalInput,
    "tenantId" | "profileId" | "alias" | "tool" | "arguments"
  >): Effect.Effect<PendingApproval | undefined, GatewayStoreError>
  collectApproval(tenantId: TenantId, id: ApprovalId): Effect.Effect<boolean, GatewayStoreError>
  claimApproval(input: {
    readonly tenantId: TenantId
    readonly id: ApprovalId
    readonly decidedBy: string | null
  }): Effect.Effect<boolean, GatewayStoreError>
  settleApproval(input: {
    readonly tenantId: TenantId
    readonly id: ApprovalId
    readonly status: "approved" | "denied" | "expired"
    readonly decidedBy: string | null
    readonly result: typeof Schema.Json.Type | null
    readonly error: string | null
  }): Effect.Effect<boolean, GatewayStoreError>
  cancelApprovalsForProfile(profileId: ProfileId): Effect.Effect<number, GatewayStoreError>

  recordAudit(input: RecordAuditInput): Effect.Effect<void, GatewayStoreError>
  listAudit(tenantId: TenantId, options: AuditQuery): Effect.Effect<ReadonlyArray<AuditRecord>, GatewayStoreError>
  countAudit(tenantId: TenantId, options: Omit<AuditQuery, "limit" | "offset">): Effect.Effect<number, GatewayStoreError>
  expireAuditArguments(now: Date): Effect.Effect<number, GatewayStoreError>

  putToolSnapshots(tenantId: TenantId, snapshots: ReadonlyArray<ToolSnapshot>): Effect.Effect<void, GatewayStoreError>
  listToolSnapshots(
    tenantId: TenantId,
    integration: IntegrationSlug
  ): Effect.Effect<ReadonlyArray<ToolSnapshot>, GatewayStoreError>
  forgetToolSnapshots(
    tenantId: TenantId,
    keys: ReadonlyArray<{
      readonly integration: IntegrationSlug
      readonly connection: ConnectionName
      readonly tool: ToolName
    }>
  ): Effect.Effect<void, GatewayStoreError>

  expireApprovals(now: Date): Effect.Effect<number, GatewayStoreError>

  close(): Effect.Effect<void, GatewayStoreError>
}

export const GatewayStoreFailureKind = Schema.Literals([
  "driver",
  "malformed-row",
  "constraint"
])
export type GatewayStoreFailureKind = typeof GatewayStoreFailureKind.Type

export class GatewayStoreError extends Schema.TaggedError<GatewayStoreError>()(
  "GatewayStoreError",
  {
    operation: Schema.String,
    kind: GatewayStoreFailureKind,
    cause: Schema.Defect()
  }
) {
  override get message(): string {
    return `${this.operation} failed (${this.kind})`
  }
}
