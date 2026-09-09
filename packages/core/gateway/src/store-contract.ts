import { Effect, Schema } from "effect"
import type { NonNegativeInt, PositiveInt } from "@mokronos/contracts"
import type {
  AccessProfile, AccessProfileId, AccessProfileTool, Alias, ApiKey, ApiKeyHash,
  ApiKeyId, ApprovalDelivery, ApprovalDeliveryAttempt, ApprovalDeliveryId,
  ApprovalDestination, ApprovalDestinationId, ApprovalId, ApprovalPolicy, ApprovalPolicyId,
  ApprovalPolicyTool, ApprovalStatus, AuditId, AuditOutcome, AuditRecord,
  AuthSession, Client, ConfigureClient, ClientCapability, ClientId, ConnectionName, ConnectionRef,
  ExternalIdentity, IdentityProvider, IntegrationSlug, Login, LoginHandoff,
  LoginHandoffHash, PendingApproval, PolicyDecision, SessionTokenHash, Subject,
  SubjectId, Tenant, TenantId, ToolName, ToolSnapshot
} from "./domain.ts"
import type { PasswordHash } from "./passwords.ts"

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

export interface CreateClientInput {
  readonly tenantId: TenantId
  readonly id: ClientId
  readonly accessProfileId: AccessProfileId
  readonly approvalPolicyId: ApprovalPolicyId
  readonly name: string
  readonly capabilities: ReadonlyArray<ClientCapability>
  readonly approvalDelivery?: ApprovalDelivery
}

export interface CreateAccessProfileInput {
  readonly tenantId: TenantId
  readonly id: AccessProfileId
  readonly name: string
  readonly isDefault?: boolean
}

export interface CreateApprovalPolicyInput {
  readonly tenantId: TenantId
  readonly id: ApprovalPolicyId
  readonly name: string
  readonly isDefault?: boolean
}

export type AccessProfileToolInput = Omit<AccessProfileTool, "accessProfileId">
export type ApprovalPolicyToolInput = Omit<ApprovalPolicyTool, "approvalPolicyId">

export interface CreateApprovalInput {
  readonly tenantId: TenantId
  readonly id: ApprovalId
  readonly clientId: ClientId
  readonly approvalPolicyId: ApprovalPolicyId
  readonly accessProfileId: AccessProfileId
  readonly alias: Alias
  readonly tool: ToolName
  readonly arguments: typeof Schema.Json.Type
  readonly expiresAt: Date
}

export interface ApprovalDeliveryJob extends ApprovalDeliveryAttempt {
  readonly tenantId: TenantId
  readonly clientId: ClientId
  readonly clientName: string
  readonly alias: Alias
  readonly tool: ToolName
  readonly expiresAt: Date
  readonly url: string
  readonly signingSecret: string
}

export interface AuditQuery {
  readonly limit?: PositiveInt
  readonly offset?: NonNegativeInt
  readonly clientId?: ClientId
  readonly alias?: Alias
  readonly tool?: ToolName
  readonly outcome?: AuditOutcome
  readonly since?: Date
}

export interface RecordAuditInput {
  readonly tenantId: TenantId
  readonly id: AuditId
  readonly clientId: ClientId | null
  readonly alias: Alias | null
  readonly tool: ToolName | null
  readonly connection: ConnectionRef | null
  readonly decision: PolicyDecision | null
  readonly outcome: AuditOutcome
  readonly message: string | null
  readonly arguments?: {
    readonly value: typeof Schema.Json.Type
    readonly expiresAt: Date
  }
}

export interface GatewayOverviewCounts {
  readonly clients: number
  readonly accessProfiles: number
  readonly accessProfileTools: number
  readonly approvalPolicies: number
  readonly approvalPolicyTools: number
  readonly keys: number
  readonly pendingApprovals: number
}

/**
 * Everything the gateway keeps. Each member answers with an Effect: the store
 * runs on a SqlClient, so there is no promise boundary to lift over.
 */
export interface GatewayStore {
  readonly databasePath: string

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

  createConfiguredClient(input: ConfigureClient & {
    readonly tenantId: TenantId
    readonly id: ClientId
    readonly accessProfileId: AccessProfileId
    readonly approvalPolicyId: ApprovalPolicyId
  }): Effect.Effect<Client, GatewayStoreError>
  createClient(input: CreateClientInput): Effect.Effect<Client, GatewayStoreError>
  listClients(tenantId: TenantId): Effect.Effect<ReadonlyArray<Client>, GatewayStoreError>
  overviewCounts(tenantId: TenantId): Effect.Effect<GatewayOverviewCounts, GatewayStoreError>
  findClientById(tenantId: TenantId, id: ClientId): Effect.Effect<Client | undefined, GatewayStoreError>
  findClientByName(tenantId: TenantId, name: string): Effect.Effect<Client | undefined, GatewayStoreError>
  updateClientSettings(input: {
    readonly tenantId: TenantId
    readonly id: ClientId
    readonly capabilities: ReadonlyArray<ClientCapability>
    readonly approvalDelivery: ApprovalDelivery
  }): Effect.Effect<Client, GatewayStoreError>
  revokeClient(tenantId: TenantId, id: ClientId): Effect.Effect<void, GatewayStoreError>

  createApprovalDestination(input: {
    readonly id: ApprovalDestinationId
    readonly tenantId: TenantId
    readonly name: string
    readonly url: string
    readonly signingSecret: string
  }): Effect.Effect<ApprovalDestination, GatewayStoreError>
  listApprovalDestinations(tenantId: TenantId): Effect.Effect<ReadonlyArray<ApprovalDestination>, GatewayStoreError>
  deleteApprovalDestination(tenantId: TenantId, id: ApprovalDestinationId): Effect.Effect<void, GatewayStoreError>
  listClientApprovalDestinationIds(clientId: ClientId): Effect.Effect<ReadonlyArray<ApprovalDestinationId>, GatewayStoreError>
  replaceClientApprovalDestinations(tenantId: TenantId, clientId: ClientId, ids: ReadonlyArray<ApprovalDestinationId>): Effect.Effect<ReadonlyArray<ApprovalDestinationId>, GatewayStoreError>
  listApprovalDeliveries(tenantId: TenantId, approvalId: ApprovalId): Effect.Effect<ReadonlyArray<ApprovalDeliveryAttempt>, GatewayStoreError>
  claimDueApprovalDeliveries(now: Date, limit: number): Effect.Effect<ReadonlyArray<ApprovalDeliveryJob>, GatewayStoreError>
  settleApprovalDelivery(input: {
    readonly id: ApprovalDeliveryId
    readonly status: "delivered" | "retrying" | "failed"
    readonly nextAttemptAt: Date | null
    readonly error: string | null
  }): Effect.Effect<void, GatewayStoreError>

  addApiKey(input: { readonly id: ApiKeyId; readonly clientId: ClientId; readonly hash: ApiKeyHash }): Effect.Effect<ApiKey, GatewayStoreError>
  listApiKeys(clientId: ClientId): Effect.Effect<ReadonlyArray<ApiKey>, GatewayStoreError>
  findApiKeyByHash(hash: ApiKeyHash): Effect.Effect<{ readonly key: ApiKey; readonly client: Client } | undefined, GatewayStoreError>
  touchApiKey(id: ApiKeyId): Effect.Effect<void, GatewayStoreError>
  revokeApiKey(id: ApiKeyId): Effect.Effect<void, GatewayStoreError>

  createAccessProfile(input: CreateAccessProfileInput): Effect.Effect<AccessProfile, GatewayStoreError>
  updateAccessProfile(tenantId: TenantId, id: AccessProfileId, name: string): Effect.Effect<AccessProfile, GatewayStoreError>
  deleteAccessProfile(tenantId: TenantId, id: AccessProfileId): Effect.Effect<void, GatewayStoreError>
  listAccessProfiles(tenantId: TenantId): Effect.Effect<ReadonlyArray<AccessProfile>, GatewayStoreError>
  findAccessProfile(tenantId: TenantId, id: AccessProfileId): Effect.Effect<AccessProfile | undefined, GatewayStoreError>
  findDefaultAccessProfile(tenantId: TenantId): Effect.Effect<AccessProfile | undefined, GatewayStoreError>
  findAccessProfileForClient(clientId: ClientId): Effect.Effect<AccessProfile | undefined, GatewayStoreError>
  listAccessProfileTools(id: AccessProfileId): Effect.Effect<ReadonlyArray<AccessProfileTool>, GatewayStoreError>
  replaceAccessProfileTools(id: AccessProfileId, tools: ReadonlyArray<AccessProfileToolInput>): Effect.Effect<ReadonlyArray<AccessProfileTool>, GatewayStoreError>
  assignAccessProfile(tenantId: TenantId, clientId: ClientId, id: AccessProfileId): Effect.Effect<Client, GatewayStoreError>

  createApprovalPolicy(input: CreateApprovalPolicyInput): Effect.Effect<ApprovalPolicy, GatewayStoreError>
  updateApprovalPolicy(tenantId: TenantId, id: ApprovalPolicyId, name: string): Effect.Effect<ApprovalPolicy, GatewayStoreError>
  deleteApprovalPolicy(tenantId: TenantId, id: ApprovalPolicyId): Effect.Effect<void, GatewayStoreError>
  listApprovalPolicies(tenantId: TenantId): Effect.Effect<ReadonlyArray<ApprovalPolicy>, GatewayStoreError>
  findApprovalPolicy(tenantId: TenantId, id: ApprovalPolicyId): Effect.Effect<ApprovalPolicy | undefined, GatewayStoreError>
  findDefaultApprovalPolicy(tenantId: TenantId): Effect.Effect<ApprovalPolicy | undefined, GatewayStoreError>
  findApprovalPolicyForClient(clientId: ClientId): Effect.Effect<ApprovalPolicy | undefined, GatewayStoreError>
  listApprovalPolicyTools(id: ApprovalPolicyId): Effect.Effect<ReadonlyArray<ApprovalPolicyTool>, GatewayStoreError>
  replaceApprovalPolicyTools(id: ApprovalPolicyId, tools: ReadonlyArray<ApprovalPolicyToolInput>): Effect.Effect<ReadonlyArray<ApprovalPolicyTool>, GatewayStoreError>
  assignApprovalPolicy(tenantId: TenantId, clientId: ClientId, id: ApprovalPolicyId): Effect.Effect<Client, GatewayStoreError>

  createApproval(input: CreateApprovalInput): Effect.Effect<PendingApproval, GatewayStoreError>
  getApproval(tenantId: TenantId, id: ApprovalId): Effect.Effect<PendingApproval | undefined, GatewayStoreError>
  listApprovals(tenantId: TenantId, status?: ApprovalStatus): Effect.Effect<ReadonlyArray<PendingApproval>, GatewayStoreError>
  findUncollectedApproval(input: Pick<CreateApprovalInput,
    "tenantId" | "clientId" | "approvalPolicyId" | "accessProfileId" | "alias" | "tool" | "arguments"
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
  cancelApprovalsForClient(clientId: ClientId): Effect.Effect<number, GatewayStoreError>

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

