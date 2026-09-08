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

export interface GatewayStoreDriver {
  readonly databasePath: string

  createTenant(input?: CreateTenantInput): Promise<Tenant>
  listTenants(): Promise<ReadonlyArray<Tenant>>
  findTenantById(id: TenantId): Promise<Tenant | undefined>
  findTenantByName(name: string): Promise<Tenant | undefined>

  createSubject(input: CreateSubjectInput): Promise<Subject>
  listSubjects(tenantId: TenantId): Promise<ReadonlyArray<Subject>>
  countSubjects(tenantId: TenantId): Promise<number>
  findSubjectById(id: SubjectId): Promise<Subject | undefined>

  createLogin(input: {
    readonly subjectId: SubjectId
    readonly tenantId: TenantId
    readonly email: string
    readonly passwordHash: PasswordHash | null
  }): Promise<LoginRecord>
  findLoginByEmail(email: string): Promise<LoginRecord | undefined>
  findLoginBySubject(subjectId: SubjectId): Promise<LoginRecord | undefined>
  countLogins(): Promise<number>
  changeLoginEmail(subjectId: SubjectId, email: string): Promise<void>
  changeLoginPassword(subjectId: SubjectId, passwordHash: string): Promise<void>
  deleteSubject(subjectId: SubjectId): Promise<void>
  deleteTenant(id: TenantId): Promise<void>
  revokeSubjectSessions(subjectId: SubjectId, exceptTokenHash?: SessionTokenHash): Promise<number>

  createSession(input: {
    readonly tokenHash: SessionTokenHash
    readonly subjectId: SubjectId
    readonly tenantId: TenantId
    readonly expiresAt: Date
  }): Promise<AuthSession>
  findLiveSession(tokenHash: SessionTokenHash): Promise<AuthSession | undefined>
  revokeSession(tokenHash: SessionTokenHash): Promise<void>
  deleteExpiredSessions(now: Date): Promise<number>

  createExternalIdentity(input: {
    readonly provider: IdentityProvider
    readonly providerSubject: string
    readonly subjectId: SubjectId
    readonly tenantId: TenantId
    readonly email: string
  }): Promise<ExternalIdentity>
  findExternalIdentity(
    provider: IdentityProvider,
    providerSubject: string
  ): Promise<ExternalIdentity | undefined>
  listExternalIdentities(subjectId: SubjectId): Promise<ReadonlyArray<ExternalIdentity>>

  createLoginHandoff(input: {
    readonly requestHash: LoginHandoffHash
    readonly expiresAt: Date
  }): Promise<LoginHandoff>
  getLoginHandoff(requestHash: LoginHandoffHash): Promise<LoginHandoff | undefined>
  completeLoginHandoff(input: {
    readonly requestHash: LoginHandoffHash
    readonly subjectId: SubjectId
    readonly tenantId: TenantId
    readonly email: string
  }): Promise<boolean>
  collectLoginHandoff(requestHash: LoginHandoffHash): Promise<boolean>
  createIdentityOAuthState(input: IdentityOAuthStateRecord): Promise<void>
  consumeIdentityOAuthState(
    stateHash: LoginHandoffHash
  ): Promise<IdentityOAuthStateRecord | undefined>
  deleteExpiredIdentityFlows(now: Date): Promise<number>

  createConfiguredClient(input: ConfigureClient & {
    readonly tenantId: TenantId
    readonly id: ClientId
    readonly accessProfileId: AccessProfileId
    readonly approvalPolicyId: ApprovalPolicyId
  }): Promise<Client>
  createClient(input: CreateClientInput): Promise<Client>
  listClients(tenantId: TenantId): Promise<ReadonlyArray<Client>>
  overviewCounts(tenantId: TenantId): Promise<GatewayOverviewCounts>
  findClientById(tenantId: TenantId, id: ClientId): Promise<Client | undefined>
  findClientByName(tenantId: TenantId, name: string): Promise<Client | undefined>
  updateClientSettings(input: {
    readonly tenantId: TenantId
    readonly id: ClientId
    readonly capabilities: ReadonlyArray<ClientCapability>
    readonly approvalDelivery: ApprovalDelivery
  }): Promise<Client>
  revokeClient(tenantId: TenantId, id: ClientId): Promise<void>

  createApprovalDestination(input: {
    readonly id: ApprovalDestinationId
    readonly tenantId: TenantId
    readonly name: string
    readonly url: string
    readonly signingSecret: string
  }): Promise<ApprovalDestination>
  listApprovalDestinations(tenantId: TenantId): Promise<ReadonlyArray<ApprovalDestination>>
  deleteApprovalDestination(tenantId: TenantId, id: ApprovalDestinationId): Promise<void>
  listClientApprovalDestinationIds(clientId: ClientId): Promise<ReadonlyArray<ApprovalDestinationId>>
  replaceClientApprovalDestinations(tenantId: TenantId, clientId: ClientId, ids: ReadonlyArray<ApprovalDestinationId>): Promise<ReadonlyArray<ApprovalDestinationId>>
  listApprovalDeliveries(tenantId: TenantId, approvalId: ApprovalId): Promise<ReadonlyArray<ApprovalDeliveryAttempt>>
  claimDueApprovalDeliveries(now: Date, limit: number): Promise<ReadonlyArray<ApprovalDeliveryJob>>
  settleApprovalDelivery(input: {
    readonly id: ApprovalDeliveryId
    readonly status: "delivered" | "retrying" | "failed"
    readonly nextAttemptAt: Date | null
    readonly error: string | null
  }): Promise<void>

  addApiKey(input: { readonly id: ApiKeyId; readonly clientId: ClientId; readonly hash: ApiKeyHash }): Promise<ApiKey>
  listApiKeys(clientId: ClientId): Promise<ReadonlyArray<ApiKey>>
  findApiKeyByHash(hash: ApiKeyHash): Promise<{ readonly key: ApiKey; readonly client: Client } | undefined>
  touchApiKey(id: ApiKeyId): Promise<void>
  revokeApiKey(id: ApiKeyId): Promise<void>

  createAccessProfile(input: CreateAccessProfileInput): Promise<AccessProfile>
  updateAccessProfile(tenantId: TenantId, id: AccessProfileId, name: string): Promise<AccessProfile>
  deleteAccessProfile(tenantId: TenantId, id: AccessProfileId): Promise<void>
  listAccessProfiles(tenantId: TenantId): Promise<ReadonlyArray<AccessProfile>>
  findAccessProfile(tenantId: TenantId, id: AccessProfileId): Promise<AccessProfile | undefined>
  findDefaultAccessProfile(tenantId: TenantId): Promise<AccessProfile | undefined>
  findAccessProfileForClient(clientId: ClientId): Promise<AccessProfile | undefined>
  listAccessProfileTools(id: AccessProfileId): Promise<ReadonlyArray<AccessProfileTool>>
  replaceAccessProfileTools(id: AccessProfileId, tools: ReadonlyArray<AccessProfileToolInput>): Promise<ReadonlyArray<AccessProfileTool>>
  assignAccessProfile(tenantId: TenantId, clientId: ClientId, id: AccessProfileId): Promise<Client>

  createApprovalPolicy(input: CreateApprovalPolicyInput): Promise<ApprovalPolicy>
  updateApprovalPolicy(tenantId: TenantId, id: ApprovalPolicyId, name: string): Promise<ApprovalPolicy>
  deleteApprovalPolicy(tenantId: TenantId, id: ApprovalPolicyId): Promise<void>
  listApprovalPolicies(tenantId: TenantId): Promise<ReadonlyArray<ApprovalPolicy>>
  findApprovalPolicy(tenantId: TenantId, id: ApprovalPolicyId): Promise<ApprovalPolicy | undefined>
  findDefaultApprovalPolicy(tenantId: TenantId): Promise<ApprovalPolicy | undefined>
  findApprovalPolicyForClient(clientId: ClientId): Promise<ApprovalPolicy | undefined>
  listApprovalPolicyTools(id: ApprovalPolicyId): Promise<ReadonlyArray<ApprovalPolicyTool>>
  replaceApprovalPolicyTools(id: ApprovalPolicyId, tools: ReadonlyArray<ApprovalPolicyToolInput>): Promise<ReadonlyArray<ApprovalPolicyTool>>
  assignApprovalPolicy(tenantId: TenantId, clientId: ClientId, id: ApprovalPolicyId): Promise<Client>

  createApproval(input: CreateApprovalInput): Promise<PendingApproval>
  getApproval(tenantId: TenantId, id: ApprovalId): Promise<PendingApproval | undefined>
  listApprovals(tenantId: TenantId, status?: ApprovalStatus): Promise<ReadonlyArray<PendingApproval>>
  findUncollectedApproval(input: Pick<CreateApprovalInput,
    "tenantId" | "clientId" | "approvalPolicyId" | "accessProfileId" | "alias" | "tool" | "arguments"
  >): Promise<PendingApproval | undefined>
  collectApproval(tenantId: TenantId, id: ApprovalId): Promise<boolean>
  claimApproval(input: {
    readonly tenantId: TenantId
    readonly id: ApprovalId
    readonly decidedBy: string | null
  }): Promise<boolean>
  settleApproval(input: {
    readonly tenantId: TenantId
    readonly id: ApprovalId
    readonly status: "approved" | "denied" | "expired"
    readonly decidedBy: string | null
    readonly result: typeof Schema.Json.Type | null
    readonly error: string | null
  }): Promise<boolean>
  cancelApprovalsForClient(clientId: ClientId): Promise<number>

  recordAudit(input: RecordAuditInput): Promise<void>
  listAudit(tenantId: TenantId, options: AuditQuery): Promise<ReadonlyArray<AuditRecord>>
  countAudit(tenantId: TenantId, options: Omit<AuditQuery, "limit" | "offset">): Promise<number>
  expireAuditArguments(now: Date): Promise<number>

  putToolSnapshots(tenantId: TenantId, snapshots: ReadonlyArray<ToolSnapshot>): Promise<void>
  listToolSnapshots(
    tenantId: TenantId,
    integration: IntegrationSlug
  ): Promise<ReadonlyArray<ToolSnapshot>>
  forgetToolSnapshots(
    tenantId: TenantId,
    keys: ReadonlyArray<{
      readonly integration: IntegrationSlug
      readonly connection: ConnectionName
      readonly tool: ToolName
    }>
  ): Promise<void>

  expireApprovals(now: Date): Promise<number>

  close(): Promise<void>
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

type EffectStoreMember<Member> = Member extends (
  ...args: infer Args
) => Promise<infer Success>
  ? (...args: Args) => Effect.Effect<Success, GatewayStoreError>
  : Member

export type GatewayStore = {
  readonly [Key in keyof GatewayStoreDriver]: EffectStoreMember<GatewayStoreDriver[Key]>
}
