import { mkdirSync } from "node:fs"
import path from "node:path"
import { createClient } from "@libsql/client"
import type { Client as LibsqlClient, InValue, Row } from "@libsql/client"
import { Context, Effect, Layer, Schema } from "effect"
import type { Encryption } from "./crypto.ts"
import {
  Alias,
  ApiKeyHash,
  ApiKeyId,
  ApprovalId,
  AuditId,
  canonicalArguments,
  ClientId,
  ConnectionName,
  defaultTenantId,
  GrantId,
  IntegrationSlug,
  SessionTokenHash,
  SubjectId,
  TenantId,
  ToolName
} from "./domain.ts"
import type {
  ApiKey,
  ApprovalStatus,
  AuditOutcome,
  AuditRecord,
  AuthSession,
  Client,
  ConnectionRef,
  Grant,
  GrantDecision,
  Login,
  PendingApproval,
  Subject,
  Tenant,
  ToolSnapshot
} from "./domain.ts"

// Everything the gateway owns lives here, above Executor's own database.
// Resolving a grant is what determines which subject an Executor instance must
// be bound to, so these rows have to be readable before that instance exists.
// See docs/adr/0001.
//
// Every row belongs to a tenant. The column was added after the fact, so the
// DDL below is the *final* shape and `migrateTenancy` brings older databases up
// to it: add the column, backfill it with the well-known default tenant, then
// recreate the two indexes whose uniqueness is per-tenant rather than global.

/** The two tables tenancy itself is built on. They exist before every other
 *  statement runs, because the migration backfills rows that reference them. */
const tenancyTableDdl = [
  `CREATE TABLE IF NOT EXISTS gateway_tenant (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL UNIQUE,
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS gateway_subject (
     id TEXT PRIMARY KEY,
     tenant_id TEXT NOT NULL REFERENCES gateway_tenant (id) ON DELETE CASCADE,
     created_at INTEGER NOT NULL
   )`,
  // Authentication details live beside the subject, never on it — the subject
  // stays an opaque human. Deleting a login deletes its sessions with it.
  `CREATE TABLE IF NOT EXISTS gateway_login (
     subject_id TEXT PRIMARY KEY REFERENCES gateway_subject (id) ON DELETE CASCADE,
     tenant_id TEXT NOT NULL REFERENCES gateway_tenant (id) ON DELETE CASCADE,
     email TEXT NOT NULL UNIQUE,
     password_hash TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS gateway_session (
     token_hash TEXT PRIMARY KEY,
     subject_id TEXT NOT NULL REFERENCES gateway_subject (id) ON DELETE CASCADE,
     tenant_id TEXT NOT NULL REFERENCES gateway_tenant (id) ON DELETE CASCADE,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL
   )`
] as const

const ddl = [
  ...tenancyTableDdl,
  `CREATE TABLE IF NOT EXISTS gateway_client (
     id TEXT PRIMARY KEY,
     tenant_id TEXT NOT NULL REFERENCES gateway_tenant (id) ON DELETE CASCADE,
     name TEXT NOT NULL,
     may_mutate INTEGER NOT NULL,
     created_at INTEGER NOT NULL,
     revoked_at INTEGER
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS gateway_client_name_tenant
     ON gateway_client (tenant_id, name)`,
  `CREATE TABLE IF NOT EXISTS gateway_api_key (
     id TEXT PRIMARY KEY,
     client_id TEXT NOT NULL REFERENCES gateway_client (id) ON DELETE CASCADE,
     hash TEXT NOT NULL UNIQUE,
     created_at INTEGER NOT NULL,
     last_used_at INTEGER,
     revoked_at INTEGER
   )`,
  `CREATE TABLE IF NOT EXISTS gateway_grant (
     id TEXT PRIMARY KEY,
     tenant_id TEXT NOT NULL REFERENCES gateway_tenant (id) ON DELETE CASCADE,
     client_id TEXT NOT NULL REFERENCES gateway_client (id) ON DELETE CASCADE,
     alias TEXT NOT NULL,
     tool TEXT NOT NULL,
     owner TEXT NOT NULL,
     subject TEXT,
     integration TEXT NOT NULL,
     connection_name TEXT NOT NULL,
     decision TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     revoked_at INTEGER
   )`,
  // One live grant per (client, alias, tool). Revoked rows stay as history, so
  // the uniqueness is partial rather than a plain constraint. A client already
  // implies its tenant, so no tenant column is needed in the key.
  `CREATE UNIQUE INDEX IF NOT EXISTS gateway_grant_live
     ON gateway_grant (client_id, alias, tool) WHERE revoked_at IS NULL`,
  `CREATE TABLE IF NOT EXISTS gateway_pending_approval (
     id TEXT PRIMARY KEY,
     tenant_id TEXT NOT NULL REFERENCES gateway_tenant (id) ON DELETE CASCADE,
     client_id TEXT NOT NULL REFERENCES gateway_client (id) ON DELETE CASCADE,
     grant_id TEXT NOT NULL,
     alias TEXT NOT NULL,
     tool TEXT NOT NULL,
     arguments TEXT NOT NULL,
     arguments_lookup TEXT,
     status TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL,
     decided_at INTEGER,
     decided_by TEXT,
     result TEXT,
     error TEXT,
     collected_at INTEGER
   )`,
  // Finding the frozen call a retry belongs to is a lookup on every frozen
  // invocation, so it is indexed rather than scanned.
  `CREATE INDEX IF NOT EXISTS gateway_pending_approval_retry
     ON gateway_pending_approval (grant_id, arguments) WHERE collected_at IS NULL`,
  `CREATE TABLE IF NOT EXISTS gateway_audit (
     id TEXT PRIMARY KEY,
     tenant_id TEXT NOT NULL REFERENCES gateway_tenant (id) ON DELETE CASCADE,
     client_id TEXT,
     alias TEXT,
     tool TEXT,
     owner TEXT,
     subject TEXT,
     integration TEXT,
     connection_name TEXT,
     decision TEXT,
     outcome TEXT NOT NULL,
     message TEXT,
     created_at INTEGER NOT NULL
   )`,
  // Split from the record above because their retention differs: the record is
  // permanent, the arguments expire.
  `CREATE TABLE IF NOT EXISTS gateway_audit_arguments (
     audit_id TEXT PRIMARY KEY REFERENCES gateway_audit (id) ON DELETE CASCADE,
     arguments TEXT NOT NULL,
     expires_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS gateway_tool_snapshot (
     tenant_id TEXT NOT NULL REFERENCES gateway_tenant (id) ON DELETE CASCADE,
     integration TEXT NOT NULL,
     connection_name TEXT NOT NULL,
     tool TEXT NOT NULL,
     input_schema TEXT,
     output_schema TEXT,
     synced_at INTEGER NOT NULL,
     PRIMARY KEY (tenant_id, integration, connection_name, tool)
   )`
] as const

/** Tables that carry a `tenant_id`, for the migration's backfill sweep. */
const tenantedTables = [
  "gateway_client",
  "gateway_grant",
  "gateway_pending_approval",
  "gateway_audit"
] as const

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
  name: Schema.String,
  may_mutate: Schema.Number,
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
  password_hash: Schema.String,
  created_at: Schema.Number
})

const SessionRow = Schema.Struct({
  token_hash: Schema.String,
  subject_id: Schema.String,
  tenant_id: Schema.String,
  created_at: Schema.Number,
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

const GrantRow = Schema.Struct({
  id: Schema.String,
  client_id: Schema.String,
  alias: Schema.String,
  tool: Schema.String,
  owner: Schema.Literals(["org", "user"]),
  subject: NullableString,
  integration: Schema.String,
  connection_name: Schema.String,
  decision: Schema.Literals(["allow", "require_approval"]),
  created_at: Schema.Number,
  revoked_at: NullableNumber
})

const ApprovalRow = Schema.Struct({
  id: Schema.String,
  client_id: Schema.String,
  grant_id: Schema.String,
  alias: Schema.String,
  tool: Schema.String,
  arguments: Schema.String,
  status: Schema.Literals(["pending", "approved", "denied", "expired"]),
  created_at: Schema.Number,
  expires_at: Schema.Number,
  decided_at: NullableNumber,
  decided_by: NullableString,
  result: NullableString,
  error: NullableString,
  collected_at: NullableNumber
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

const clientColumns = ["id", "tenant_id", "name", "may_mutate", "created_at", "revoked_at"]
const tenantColumns = ["id", "name", "created_at"]
const subjectColumns = ["id", "tenant_id", "created_at"]
const loginColumns = ["subject_id", "tenant_id", "email", "password_hash", "created_at"]
const sessionColumns = ["token_hash", "subject_id", "tenant_id", "created_at", "expires_at"]
const apiKeyColumns = ["id", "client_id", "hash", "created_at", "last_used_at", "revoked_at"]
const grantColumns = [
  "id", "client_id", "alias", "tool", "owner", "subject",
  "integration", "connection_name", "decision", "created_at", "revoked_at"
]
const approvalColumns = [
  "id", "client_id", "grant_id", "alias", "tool", "arguments", "status",
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
const decodeApiKeyRow = Schema.decodeUnknownSync(ApiKeyRow)
const decodeGrantRow = Schema.decodeUnknownSync(GrantRow)
const decodeApprovalRow = Schema.decodeUnknownSync(ApprovalRow)
const decodeAuditRow = Schema.decodeUnknownSync(AuditRow)
const decodeSnapshotRow = Schema.decodeUnknownSync(SnapshotRow)
const decodeJsonText = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))

const parseJsonColumn = (value: string): typeof Schema.Json.Type =>
  decodeJsonText(value)

const date = (value: number): Date => new Date(value)
const nullableDate = (value: number | null): Date | null =>
  value === null ? null : new Date(value)
const millis = (value: Date): number => value.getTime()

const toClient = (row: Row): Client => {
  const decoded = decodeClientRow(pick(row, clientColumns))
  return {
    id: ClientId.make(decoded.id),
    tenantId: TenantId.make(decoded.tenant_id),
    name: decoded.name,
    mayMutate: decoded.may_mutate !== 0,
    createdAt: date(decoded.created_at),
    revokedAt: nullableDate(decoded.revoked_at)
  }
}

const toTenant = (row: Row): Tenant => {
  const decoded = decodeTenantRow(pick(row, tenantColumns))
  return {
    id: TenantId.make(decoded.id),
    name: decoded.name,
    createdAt: date(decoded.created_at)
  }
}

const toSubject = (row: Row): Subject => {
  const decoded = decodeSubjectRow(pick(row, subjectColumns))
  return {
    id: SubjectId.make(decoded.id),
    tenantId: TenantId.make(decoded.tenant_id),
    createdAt: date(decoded.created_at)
  }
}

const toLoginRecord = (row: Row): LoginRecord => {
  const decoded = decodeLoginRow(pick(row, loginColumns))
  return {
    subjectId: SubjectId.make(decoded.subject_id),
    tenantId: TenantId.make(decoded.tenant_id),
    email: decoded.email,
    passwordHash: decoded.password_hash,
    createdAt: date(decoded.created_at)
  }
}

const toAuthSession = (row: Row): AuthSession => {
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

const toApiKey = (row: Row): ApiKey => {
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

const toGrant = (row: Row): Grant => {
  const decoded = decodeGrantRow(pick(row, grantColumns))
  return {
    id: GrantId.make(decoded.id),
    clientId: ClientId.make(decoded.client_id),
    alias: Alias.make(decoded.alias),
    tool: ToolName.make(decoded.tool),
    connection: toConnectionRef(decoded),
    decision: decoded.decision,
    createdAt: date(decoded.created_at),
    revokedAt: nullableDate(decoded.revoked_at)
  }
}

/** Reads a stored approval back into the domain. `open` undoes whatever the
 *  write side did to `arguments`/`result`; for plaintext stores it is the
 *  identity, so one reader serves both worlds. */
const toApproval = (row: Row, open: (text: string) => string = identity): PendingApproval => {
  const decoded = decodeApprovalRow(pick(row, approvalColumns))
  return {
    id: ApprovalId.make(decoded.id),
    clientId: ClientId.make(decoded.client_id),
    grantId: GrantId.make(decoded.grant_id),
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

const toAuditRecord = (row: Row): AuditRecord => {
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

const toSnapshot = (row: Row): ToolSnapshot => {
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

// --- store ------------------------------------------------------------------

export interface CreateTenantInput {
  readonly id?: TenantId
  readonly name: string
}

export interface CreateSubjectInput {
  readonly id: SubjectId
  readonly tenantId: TenantId
}

/** A login as stored: everything {@link Login} carries plus the password hash.
 *  The hash never leaves the store boundary — verification happens through
 *  `findLoginByEmail` returning it, and nothing serialises this type. */
export interface LoginRecord extends Login {
  readonly passwordHash: string
}

export interface CreateClientInput {
  readonly tenantId: TenantId
  readonly id: ClientId
  readonly name: string
  readonly mayMutate: boolean
}

export interface CreateGrantInput {
  readonly tenantId: TenantId
  readonly id: GrantId
  readonly clientId: ClientId
  readonly alias: Alias
  readonly tool: ToolName
  readonly connection: ConnectionRef
  readonly decision: GrantDecision
}

export interface CreateApprovalInput {
  readonly tenantId: TenantId
  readonly id: ApprovalId
  readonly clientId: ClientId
  readonly grantId: GrantId
  readonly alias: Alias
  readonly tool: ToolName
  readonly arguments: typeof Schema.Json.Type
  readonly expiresAt: Date
}

/** Which slice of the trail to read. Every field narrows; none of them is
 *  required, and `limit`/`offset` window whatever is left. */
export interface AuditQuery {
  readonly limit?: number
  readonly offset?: number
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
  readonly decision: GrantDecision | null
  readonly outcome: AuditOutcome
  readonly message: string | null
  readonly arguments?: {
    readonly value: typeof Schema.Json.Type
    readonly expiresAt: Date
  }
}

export interface GatewayStore {
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
    readonly passwordHash: string
  }): Promise<LoginRecord>
  findLoginByEmail(email: string): Promise<LoginRecord | undefined>
  countLogins(): Promise<number>
  /** Rewrites the login's email. Uniqueness is enforced by the schema; the
   *  route checks for a friendly message first. */
  changeLoginEmail(subjectId: SubjectId, email: string): Promise<void>
  changeLoginPassword(subjectId: SubjectId, passwordHash: string): Promise<void>
  /** Removes the subject and, by cascade, its login and every session. */
  deleteSubject(subjectId: SubjectId): Promise<void>
  /** Removes a workspace and everything scoped to it — clients, keys, grants,
   *  approvals, audit rows. Only safe once no subjects remain. */
  deleteTenant(id: TenantId): Promise<void>
  /** Deletes the subject's sessions, keeping at most one (the device asking).
   *  Returns how many died. */
  revokeSubjectSessions(subjectId: SubjectId, exceptTokenHash?: SessionTokenHash): Promise<number>

  createSession(input: {
    readonly tokenHash: SessionTokenHash
    readonly subjectId: SubjectId
    readonly tenantId: TenantId
    readonly expiresAt: Date
  }): Promise<AuthSession>
  /** A live session, or nothing. Expired sessions read as absent: expiry is
   *  the same decision revocation is. */
  findLiveSession(tokenHash: SessionTokenHash): Promise<AuthSession | undefined>
  revokeSession(tokenHash: SessionTokenHash): Promise<void>
  deleteExpiredSessions(now: Date): Promise<number>

  createClient(input: CreateClientInput): Promise<Client>
  listClients(tenantId: TenantId): Promise<ReadonlyArray<Client>>
  findClientById(tenantId: TenantId, id: ClientId): Promise<Client | undefined>
  findClientByName(tenantId: TenantId, name: string): Promise<Client | undefined>
  revokeClient(tenantId: TenantId, id: ClientId): Promise<void>

  addApiKey(input: { readonly id: ApiKeyId; readonly clientId: ClientId; readonly hash: ApiKeyHash }): Promise<ApiKey>
  listApiKeys(clientId: ClientId): Promise<ReadonlyArray<ApiKey>>
  /** Resolves a presented credential to its key *and* the live client behind
   *  it, in one read. Deliberately not tenant-scoped: the tenant is an output
   *  of this lookup, not an input — the 256-bit hash is what vouches for it. */
  findApiKeyByHash(hash: ApiKeyHash): Promise<{ readonly key: ApiKey; readonly client: Client } | undefined>
  touchApiKey(id: ApiKeyId): Promise<void>
  revokeApiKey(id: ApiKeyId): Promise<void>

  createGrant(input: CreateGrantInput): Promise<Grant>
  listGrants(clientId: ClientId): Promise<ReadonlyArray<Grant>>
  findGrant(clientId: ClientId, alias: Alias, tool: ToolName): Promise<Grant | undefined>
  revokeGrant(tenantId: TenantId, id: GrantId): Promise<void>

  createApproval(input: CreateApprovalInput): Promise<PendingApproval>
  getApproval(tenantId: TenantId, id: ApprovalId): Promise<PendingApproval | undefined>
  listApprovals(tenantId: TenantId, status?: ApprovalStatus): Promise<ReadonlyArray<PendingApproval>>
  /** The frozen call a retry of these arguments belongs to, if one is still
   *  undelivered. This is what makes a retrying step ask a human once. */
  findUncollectedApproval(
    grantId: GrantId,
    argumentsValue: Schema.Json
  ): Promise<PendingApproval | undefined>
  /** Hands a settled approval's outcome to the caller, once. Returns false if
   *  another attempt collected it first, so concurrent retries cannot both
   *  claim the same decision. */
  collectApproval(tenantId: TenantId, id: ApprovalId): Promise<boolean>
  settleApproval(input: {
    readonly tenantId: TenantId
    readonly id: ApprovalId
    readonly status: ApprovalStatus
    readonly decidedBy: string | null
    readonly result: typeof Schema.Json.Type | null
    readonly error: string | null
  }): Promise<void>
  /** Cancels a revoked client's frozen actions. Key revocation deliberately
   *  does not do this — rotation must not destroy in-flight work. */
  cancelApprovalsForClient(clientId: ClientId): Promise<number>

  recordAudit(input: RecordAuditInput): Promise<void>
  /** The trail is permanent and therefore unbounded, so it is the one listing
   *  that is read through a window and a filter rather than whole. */
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

  /** Turns approvals nobody decided on into decisions. Expiry means the
   *  invocation does not happen — it is not an absence of an answer. */
  expireApprovals(now: Date): Promise<number>

  close(): Promise<void>
}

export class GatewayStoreInitializationError extends Schema.TaggedErrorClass<GatewayStoreInitializationError>()(
  "GatewayStoreInitializationError",
  { databasePath: Schema.String, cause: Schema.Defect }
) {}

/** Scoped access to the gateway database. Promise-based store methods remain at
 * the libsql boundary; acquisition and release belong to the Layer lifecycle. */
export class GatewayStoreService extends Context.Service<
  GatewayStoreService,
  GatewayStore
>()("@mokronos/integrations/GatewayStore") {
  static readonly layer = (
    databasePath: string,
    encryption?: Encryption,
    options?: GatewayStoreOptions
  ): Layer.Layer<GatewayStoreService, GatewayStoreInitializationError> =>
    Layer.effect(
      GatewayStoreService,
      Effect.acquireRelease(
        Effect.tryPromise({
          try: () => createGatewayStore(databasePath, encryption, options),
          catch: (cause) => new GatewayStoreInitializationError({ databasePath, cause })
        }),
        (store) => Effect.promise(() => store.close())
      )
    )
}

const now = (): number => Date.now()

/** Adds columns an older database is missing. Idempotent, and narrow on
 *  purpose: this is a schema top-up for additive changes, not a migration
 *  framework. Anything that rewrites data belongs in one. */
const addMissingColumns = async (
  database: LibsqlClient,
  table: string,
  columns: Readonly<Record<string, string>>
): Promise<void> => {
  const existing = new Set(
    (await database.execute(`PRAGMA table_info(${table})`)).rows.map((row) => String(row["name"]))
  )
  // No columns means no table: this is a fresh database, and the DDL that
  // follows creates it with every column already in place.
  if (existing.size === 0) return
  for (const [column, type] of Object.entries(columns)) {
    if (existing.has(column)) continue
    await database.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
  }
}

/** Brings a pre-tenancy database up to the current shape.
 *
 * Three steps, each idempotent:
 *
 *  1. Ensure the well-known default tenant row exists — everything backfilled
 *     points at it, and a fresh database needs it too.
 *  2. Add the `tenant_id` column where an older table lacks it, then fill it
 *     with the default tenant. A one-tenant-per-deployment gateway has exactly
 *     one possible value, so this is a constant fill rather than a guess.
 *  3. Recreate the indexes whose uniqueness is per-tenant. The old global
 *     client-name index would let tenant B be blocked by tenant A's name
 *     choice; the tool-snapshot primary key would make two tenants overwrite
 *     one another's baselines. The snapshot rebuild is the only statement here
 *     that rewrites rows, and it runs only when the old shape is detected.
 */
const migrateTenancy = async (database: LibsqlClient): Promise<void> => {
  await database.execute({
    sql: "INSERT INTO gateway_tenant (id, name, created_at) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING",
    args: [defaultTenantId, "Default", Date.now()]
  })
  for (const table of tenantedTables) {
    // A fresh database has none of these yet — the final-shape DDL below
    // creates them complete. Only an existing table needs topping up.
    if (!await tableExists(database, table)) continue
    await addMissingColumns(database, table, { tenant_id: "TEXT REFERENCES gateway_tenant (id)" })
    await database.execute(
      `UPDATE ${table} SET tenant_id = ? WHERE tenant_id IS NULL`,
      [defaultTenantId]
    )
  }
  // The old global name index is superseded by the per-tenant one in the DDL.
  // Dropped before any early return: leaving it in place would let one
  // tenant's client name block every other tenant's.
  await database.execute("DROP INDEX IF EXISTS gateway_client_name")

  if (!await tableExists(database, "gateway_tool_snapshot")) return

  await addMissingColumns(database, "gateway_tool_snapshot", {
    tenant_id: "TEXT REFERENCES gateway_tenant (id)"
  })

  // Rebuild the snapshot table when its primary key is still the pre-tenancy
  // shape. Detected from sqlite_master because PRAGMA cannot see the PK of an
  // older row directly and a WITHOUT ROWID check would be indirect.
  const snapshotSql = await one_(
    database,
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'gateway_tool_snapshot'"
  )
  if (snapshotSql !== undefined && !String(snapshotSql["sql"] ?? "").includes("tenant_id")) {
    await database.execute("ALTER TABLE gateway_tool_snapshot RENAME TO gateway_tool_snapshot_old")
    await database.execute(`CREATE TABLE gateway_tool_snapshot (
       tenant_id TEXT NOT NULL REFERENCES gateway_tenant (id) ON DELETE CASCADE,
       integration TEXT NOT NULL,
       connection_name TEXT NOT NULL,
       tool TEXT NOT NULL,
       input_schema TEXT,
       output_schema TEXT,
       synced_at INTEGER NOT NULL,
       PRIMARY KEY (tenant_id, integration, connection_name, tool)
     )`)
    await database.execute(`
       INSERT INTO gateway_tool_snapshot
         (tenant_id, integration, connection_name, tool, input_schema, output_schema, synced_at)
       SELECT COALESCE(tenant_id, ?), integration, connection_name, tool,
              input_schema, output_schema, synced_at
         FROM gateway_tool_snapshot_old`,
      [defaultTenantId]
    )
    await database.execute("DROP TABLE gateway_tool_snapshot_old")
  } else if (snapshotSql !== undefined) {
    // Column exists but was added by addMissingColumns without the composite
    // key: deduplicate defensively, then swap the PK in the same guarded way.
    await database.execute(`
      DELETE FROM gateway_tool_snapshot WHERE rowid NOT IN (
        SELECT MIN(rowid) FROM gateway_tool_snapshot GROUP BY tenant_id, integration, connection_name, tool
      )`)
  }
}

/** Single-row helper for the migration, which runs before the store's own
 *  query helpers exist. */
const one_ = async (
  database: LibsqlClient,
  sql: string,
  args: ReadonlyArray<InValue> = []
): Promise<Row | undefined> =>
  (await database.execute({ sql, args: [...args] })).rows[0]

const tableExists = async (database: LibsqlClient, name: string): Promise<boolean> =>
  await one_(database, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [name]) !== undefined

/** One filter builder for both the page and its total, so a listing can never
 *  report a count that belongs to a different question than the rows. */
/** A composed SQL fragment and the values it binds, kept together so a caller
 *  cannot pass one without the other. */
interface SqlFilter {
  readonly where: string
  readonly args: ReadonlyArray<InValue>
}

const auditFilter = (
  options: Omit<AuditQuery, "limit" | "offset">
): SqlFilter => {
  const clauses: Array<string> = []
  const args: Array<InValue> = []
  if (options.clientId !== undefined) {
    clauses.push("client_id = ?")
    args.push(options.clientId)
  }
  if (options.alias !== undefined) {
    clauses.push("alias = ?")
    args.push(options.alias)
  }
  if (options.tool !== undefined) {
    clauses.push("tool = ?")
    args.push(options.tool)
  }
  if (options.outcome !== undefined) {
    clauses.push("outcome = ?")
    args.push(options.outcome)
  }
  if (options.since !== undefined) {
    clauses.push("created_at >= ?")
    args.push(options.since.getTime())
  }
  // A bare conjunction rather than a full clause: every reader prepends its
  // own tenant scoping with `WHERE tenant_id = ?`.
  return {
    where: clauses.length === 0 ? "" : ` AND ${clauses.join(" AND ")}`,
    args
  }
}

/** Overrides for where the gateway database actually lives. Everything unset
 *  keeps the historical behaviour: one SQLite file under `home`. */
export interface GatewayStoreOptions {
  /** A caller-built client. When present, the store skips creating its own
   *  file-backed client and the engine-level pragmas — the caller owns the
   *  storage engine and its setup (e.g. a D1 binding on Workers). */
  readonly client?: LibsqlClient
}

const openFileDatabase = async (databasePath: string): Promise<LibsqlClient> => {
  mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 })
  const database: LibsqlClient = createClient({ url: `file:${databasePath}` })
  await database.execute("PRAGMA journal_mode = WAL")
  await database.execute("PRAGMA foreign_keys = ON")
  return database
}

export const createGatewayStore = async (
  databasePath: string,
  encryption?: Encryption,
  options: GatewayStoreOptions = {}
): Promise<GatewayStore> => {
  const database: LibsqlClient =
    options.client ?? await openFileDatabase(databasePath)
  // `CREATE TABLE IF NOT EXISTS` does nothing for a database that already
  // exists, so a column added after the fact has to be added explicitly — and
  // before the DDL below, which indexes it. A gateway that has been running
  // since before delivery-once tracking must not have to be deleted to get it.
  await addMissingColumns(database, "gateway_pending_approval", {
    collected_at: "INTEGER",
    arguments_lookup: "TEXT"
  })
  // Tenancy tables first, then the backfill that references them, then the
  // rest of the final shape.
  for (const statement of tenancyTableDdl) await database.execute(statement)
  await migrateTenancy(database)
  for (const statement of ddl) await database.execute(statement)

  const one = async (sql: string, args: ReadonlyArray<InValue>): Promise<Row | undefined> => {
    const result = await database.execute({ sql, args: [...args] })
    return result.rows[0]
  }

  const all = async (sql: string, args: ReadonlyArray<InValue>): Promise<ReadonlyArray<Row>> => {
    const result = await database.execute({ sql, args: [...args] })
    return result.rows
  }

  const run = async (sql: string, args: ReadonlyArray<InValue>): Promise<void> => {
    await database.execute({ sql, args: [...args] })
  }

  const requireClient = async (id: ClientId): Promise<Client> => {
    const row = await one("SELECT * FROM gateway_client WHERE id = ?", [id])
    if (row === undefined) throw new Error(`Unknown client ${id}`)
    return toClient(row)
  }

  // --- payload sealing --------------------------------------------------------
  // Approval arguments/results and audit arguments are where caller data (and
  // therefore PII) lives. When a master key is configured they are sealed at
  // rest; reads open them, and rows written before encryption stay readable
  // because `open` passes plaintext through.

  const sealText = (text: string): string =>
    encryption === undefined ? text : encryption.seal(text)
  const openApproval = (row: Row): PendingApproval =>
    toApproval(row, encryption === undefined ? identity : encryption.open)

  const requireSession = async (tokenHash: SessionTokenHash): Promise<AuthSession> => {
    const row = await one(
      `SELECT gateway_session.*, gateway_login.email
         FROM gateway_session JOIN gateway_login ON gateway_login.subject_id = gateway_session.subject_id
        WHERE gateway_session.token_hash = ?`,
      [tokenHash]
    )
    if (row === undefined) throw new Error(`Failed to store session`)
    return toAuthSession(row)
  }

  return {
    databasePath,

    createTenant: async (input) => {
      const id = input?.id ?? TenantId.make(crypto.randomUUID())
      const name = input?.name ?? "Untitled"
      await run(
        "INSERT INTO gateway_tenant (id, name, created_at) VALUES (?, ?, ?)",
        [id, name, now()]
      )
      const row = await one("SELECT * FROM gateway_tenant WHERE id = ?", [id])
      if (row === undefined) throw new Error(`Failed to store tenant ${id}`)
      return toTenant(row)
    },

    listTenants: async () =>
      (await all("SELECT * FROM gateway_tenant ORDER BY created_at", [])).map(toTenant),

    findTenantById: async (id) => {
      const row = await one("SELECT * FROM gateway_tenant WHERE id = ?", [id])
      return row === undefined ? undefined : toTenant(row)
    },

    findTenantByName: async (name) => {
      const row = await one("SELECT * FROM gateway_tenant WHERE name = ?", [name])
      return row === undefined ? undefined : toTenant(row)
    },

    createSubject: async (input) => {
      await run(
        "INSERT INTO gateway_subject (id, tenant_id, created_at) VALUES (?, ?, ?)",
        [input.id, input.tenantId, now()]
      )
      const row = await one("SELECT * FROM gateway_subject WHERE id = ?", [input.id])
      if (row === undefined) throw new Error(`Failed to store subject ${input.id}`)
      return toSubject(row)
    },

    listSubjects: async (tenantId) =>
      (await all(
        "SELECT * FROM gateway_subject WHERE tenant_id = ? ORDER BY created_at",
        [tenantId]
      )).map(toSubject),

    countSubjects: async (tenantId) => {
      const row = await one(
        "SELECT COUNT(*) AS total FROM gateway_subject WHERE tenant_id = ?",
        [tenantId]
      )
      return row === undefined ? 0 : Number(row["total"] ?? 0)
    },

    findSubjectById: async (id) => {
      const row = await one("SELECT * FROM gateway_subject WHERE id = ?", [id])
      return row === undefined ? undefined : toSubject(row)
    },

    createLogin: async (input) => {
      await run(
        "INSERT INTO gateway_login (subject_id, tenant_id, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)",
        [input.subjectId, input.tenantId, input.email, input.passwordHash, now()]
      )
      const row = await one("SELECT * FROM gateway_login WHERE subject_id = ?", [input.subjectId])
      if (row === undefined) throw new Error(`Failed to store login for ${input.email}`)
      return toLoginRecord(row)
    },

    findLoginByEmail: async (email) => {
      const row = await one("SELECT * FROM gateway_login WHERE email = ?", [email])
      return row === undefined ? undefined : toLoginRecord(row)
    },

    countLogins: async () => {
      const row = await one("SELECT COUNT(*) AS total FROM gateway_login", [])
      return row === undefined ? 0 : Number(row["total"] ?? 0)
    },

    changeLoginEmail: async (subjectId, email) => {
      await run("UPDATE gateway_login SET email = ? WHERE subject_id = ?", [email, subjectId])
    },

    changeLoginPassword: async (subjectId, passwordHash) => {
      await run("UPDATE gateway_login SET password_hash = ? WHERE subject_id = ?", [
        passwordHash,
        subjectId
      ])
    },

    deleteSubject: async (subjectId) => {
      // The cascade takes the login and every session with it — the store's
      // own DDL declares login and session as children of the subject.
      await run("DELETE FROM gateway_subject WHERE id = ?", [subjectId])
    },

    deleteTenant: async (id) => {
      // Every tenant-scoped table declares ON DELETE CASCADE, so one delete
      // reclaims clients, keys, grants, approvals, audit rows, and snapshots.
      await run("DELETE FROM gateway_tenant WHERE id = ?", [id])
    },

    revokeSubjectSessions: async (subjectId, exceptTokenHash) => {
      const result =
        exceptTokenHash === undefined
          ? await database.execute({
            sql: "DELETE FROM gateway_session WHERE subject_id = ?",
            args: [subjectId]
          })
          : await database.execute({
            sql: "DELETE FROM gateway_session WHERE subject_id = ? AND token_hash != ?",
            args: [subjectId, exceptTokenHash]
          })
      return Number(result.rowsAffected)
    },

    createSession: async (input) => {
      await run(
        "INSERT INTO gateway_session (token_hash, subject_id, tenant_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
        [input.tokenHash, input.subjectId, input.tenantId, now(), millis(input.expiresAt)]
      )
      return await requireSession(input.tokenHash)
    },

    // Joined with the login for the display email; expired rows read as absent.
    findLiveSession: async (tokenHash) => {
      const row = await one(
        `SELECT gateway_session.*, gateway_login.email
           FROM gateway_session JOIN gateway_login ON gateway_login.subject_id = gateway_session.subject_id
          WHERE gateway_session.token_hash = ? AND gateway_session.expires_at > ?`,
        [tokenHash, now()]
      )
      return row === undefined ? undefined : toAuthSession(row)
    },

    revokeSession: async (tokenHash) => {
      await run("DELETE FROM gateway_session WHERE token_hash = ?", [tokenHash])
    },

    deleteExpiredSessions: async (at) => {
      const result = await database.execute({
        sql: "DELETE FROM gateway_session WHERE expires_at <= ?",
        args: [millis(at)]
      })
      return Number(result.rowsAffected)
    },

    createClient: async (input) => {
      await run(
        "INSERT INTO gateway_client (id, tenant_id, name, may_mutate, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, NULL)",
        [input.id, input.tenantId, input.name, input.mayMutate ? 1 : 0, now()]
      )
      return await requireClient(input.id)
    },

    listClients: async (tenantId) =>
      (await all(
        "SELECT * FROM gateway_client WHERE tenant_id = ? ORDER BY created_at",
        [tenantId]
      )).map(toClient),

    findClientById: async (tenantId, id) => {
      const row = await one(
        "SELECT * FROM gateway_client WHERE tenant_id = ? AND id = ?",
        [tenantId, id]
      )
      return row === undefined ? undefined : toClient(row)
    },

    findClientByName: async (tenantId, name) => {
      const row = await one(
        "SELECT * FROM gateway_client WHERE tenant_id = ? AND name = ?",
        [tenantId, name]
      )
      return row === undefined ? undefined : toClient(row)
    },

    revokeClient: async (tenantId, id) => {
      await run(
        "UPDATE gateway_client SET revoked_at = ? WHERE tenant_id = ? AND id = ? AND revoked_at IS NULL",
        [now(), tenantId, id]
      )
    },

    addApiKey: async (input) => {
      await run(
        "INSERT INTO gateway_api_key (id, client_id, hash, created_at, last_used_at, revoked_at) VALUES (?, ?, ?, ?, NULL, NULL)",
        [input.id, input.clientId, input.hash, now()]
      )
      const row = await one("SELECT * FROM gateway_api_key WHERE id = ?", [input.id])
      if (row === undefined) throw new Error(`Failed to store API key ${input.id}`)
      return toApiKey(row)
    },

    listApiKeys: async (clientId) =>
      (await all("SELECT * FROM gateway_api_key WHERE client_id = ? ORDER BY created_at", [clientId]))
        .map(toApiKey),

    findApiKeyByHash: async (hash) => {
      const row = await one(
        `SELECT gateway_api_key.*, gateway_client.tenant_id AS client_tenant_id,
                gateway_client.name AS client_name, gateway_client.may_mutate AS client_may_mutate,
                gateway_client.created_at AS client_created_at, gateway_client.revoked_at AS client_revoked_at
           FROM gateway_api_key JOIN gateway_client ON gateway_client.id = gateway_api_key.client_id
          WHERE gateway_api_key.hash = ?`,
        [hash]
      )
      if (row === undefined) return undefined
      return {
        key: toApiKey(row),
        client: toClient({
          ...row,
          // The joined client columns shadow what the key row carries; every
          // client field must come from its aliased column, including id.
          id: row["client_id"] ?? "",
          tenant_id: row["client_tenant_id"] ?? "",
          name: row["client_name"] ?? "",
          may_mutate: row["client_may_mutate"] ?? 0,
          created_at: row["client_created_at"] ?? 0,
          revoked_at: row["client_revoked_at"] ?? null
        })
      }
    },

    touchApiKey: async (id) => {
      await run("UPDATE gateway_api_key SET last_used_at = ? WHERE id = ?", [now(), id])
    },

    revokeApiKey: async (id) => {
      await run("UPDATE gateway_api_key SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", [now(), id])
    },

    createGrant: async (input) => {
      const subject = input.connection.owner === "user" ? input.connection.subject : null
      await run(
        `INSERT INTO gateway_grant
           (id, tenant_id, client_id, alias, tool, owner, subject, integration, connection_name, decision, created_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        [
          input.id,
          input.tenantId,
          input.clientId,
          input.alias,
          input.tool,
          input.connection.owner,
          subject,
          input.connection.integration,
          input.connection.name,
          input.decision,
          now()
        ]
      )
      const row = await one("SELECT * FROM gateway_grant WHERE id = ?", [input.id])
      if (row === undefined) throw new Error(`Failed to store grant ${input.id}`)
      return toGrant(row)
    },

    listGrants: async (clientId) =>
      (await all(
        "SELECT * FROM gateway_grant WHERE client_id = ? AND revoked_at IS NULL ORDER BY alias, tool",
        [clientId]
      )).map(toGrant),

    findGrant: async (clientId, alias, tool) => {
      const row = await one(
        "SELECT * FROM gateway_grant WHERE client_id = ? AND alias = ? AND tool = ? AND revoked_at IS NULL",
        [clientId, alias, tool]
      )
      return row === undefined ? undefined : toGrant(row)
    },

    revokeGrant: async (tenantId, id) => {
      await run(
        "UPDATE gateway_grant SET revoked_at = ? WHERE tenant_id = ? AND id = ? AND revoked_at IS NULL",
        [now(), tenantId, id]
      )
    },

    createApproval: async (input) => {
      // Stored canonically so that the same request, however its JSON was
      // built, matches the frozen call it is a retry of — then sealed. The
      // keyed digest of the canonical text rides alongside, because equality
      // search over randomised ciphertext is impossible by design.
      const canonical = canonicalArguments(input.arguments)
      await run(
        `INSERT INTO gateway_pending_approval
           (id, tenant_id, client_id, grant_id, alias, tool, arguments, arguments_lookup, status, created_at, expires_at, decided_at, decided_by, result, error, collected_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL, NULL, NULL, NULL, NULL)`,
        [
          input.id,
          input.tenantId,
          input.clientId,
          input.grantId,
          input.alias,
          input.tool,
          sealText(canonical),
          encryption === undefined ? null : encryption.lookup(canonical),
          now(),
          millis(input.expiresAt)
        ]
      )
      const row = await one("SELECT * FROM gateway_pending_approval WHERE id = ?", [input.id])
      if (row === undefined) throw new Error(`Failed to store approval ${input.id}`)
      return openApproval(row)
    },

    findUncollectedApproval: async (grantId, argumentsValue) => {
      const canonical = canonicalArguments(argumentsValue)
      const row = await one(
        `SELECT * FROM gateway_pending_approval
          WHERE grant_id = ?
            AND ((arguments_lookup IS NOT NULL AND arguments_lookup = ?)
              OR (arguments_lookup IS NULL AND arguments = ?))
            AND collected_at IS NULL
          ORDER BY created_at DESC LIMIT 1`,
        [
          grantId,
          encryption === undefined ? canonical : encryption.lookup(canonical),
          canonical
        ]
      )
      return row === undefined ? undefined : openApproval(row)
    },

    collectApproval: async (tenantId, id) => {
      const result = await database.execute({
        sql: `UPDATE gateway_pending_approval
                SET collected_at = ?
              WHERE tenant_id = ? AND id = ? AND collected_at IS NULL AND status <> 'pending'`,
        args: [now(), tenantId, id]
      })
      return Number(result.rowsAffected) > 0
    },

    getApproval: async (tenantId, id) => {
      const row = await one(
        "SELECT * FROM gateway_pending_approval WHERE tenant_id = ? AND id = ?",
        [tenantId, id]
      )
      return row === undefined ? undefined : openApproval(row)
    },

    listApprovals: async (tenantId, status) =>
      (status === undefined
        ? await all(
          "SELECT * FROM gateway_pending_approval WHERE tenant_id = ? ORDER BY created_at DESC",
          [tenantId]
        )
        : await all(
          "SELECT * FROM gateway_pending_approval WHERE tenant_id = ? AND status = ? ORDER BY created_at DESC",
          [tenantId, status]
        )).map(openApproval),

    settleApproval: async (input) => {
      await run(
        `UPDATE gateway_pending_approval
            SET status = ?, decided_at = ?, decided_by = ?, result = ?, error = ?
          WHERE tenant_id = ? AND id = ? AND status = 'pending'`,
        [
          input.status,
          now(),
          input.decidedBy,
          input.result === null ? null : sealText(JSON.stringify(input.result)),
          input.error,
          input.tenantId,
          input.id
        ]
      )
    },

    cancelApprovalsForClient: async (clientId) => {
      const result = await database.execute({
        sql: `UPDATE gateway_pending_approval
                SET status = 'denied', decided_at = ?, decided_by = 'client-revoked'
              WHERE client_id = ? AND status = 'pending'`,
        args: [now(), clientId]
      })
      return Number(result.rowsAffected)
    },

    recordAudit: async (input) => {
      const connection = input.connection
      await run(
        `INSERT INTO gateway_audit
           (id, tenant_id, client_id, alias, tool, owner, subject, integration, connection_name, decision, outcome, message, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.id,
          input.tenantId,
          input.clientId,
          input.alias,
          input.tool,
          connection === null ? null : connection.owner,
          connection === null || connection.owner !== "user" ? null : connection.subject,
          connection === null ? null : connection.integration,
          connection === null ? null : connection.name,
          input.decision,
          input.outcome,
          input.message,
          now()
        ]
      )
      if (input.arguments !== undefined) {
        await run(
          "INSERT INTO gateway_audit_arguments (audit_id, arguments, expires_at) VALUES (?, ?, ?)",
          [
            input.id,
            sealText(JSON.stringify(input.arguments.value)),
            millis(input.arguments.expiresAt)
          ]
        )
      }
    },

    listAudit: async (tenantId, options) => {
      const filter = auditFilter(options)
      return (await all(
        `SELECT * FROM gateway_audit WHERE tenant_id = ?${filter.where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
        [tenantId, ...filter.args, options.limit ?? 50, options.offset ?? 0]
      )).map(toAuditRecord)
    },

    countAudit: async (tenantId, options) => {
      const filter = auditFilter(options)
      const row = await one(
        `SELECT COUNT(*) AS total FROM gateway_audit WHERE tenant_id = ?${filter.where}`,
        [tenantId, ...filter.args]
      )
      return row === undefined ? 0 : Number(row["total"] ?? 0)
    },

    expireAuditArguments: async (at) => {
      const result = await database.execute({
        sql: "DELETE FROM gateway_audit_arguments WHERE expires_at <= ?",
        args: [millis(at)]
      })
      return Number(result.rowsAffected)
    },

    putToolSnapshots: async (tenantId, snapshots) => {
      for (const snapshot of snapshots) {
        await run(
          `INSERT INTO gateway_tool_snapshot
             (tenant_id, integration, connection_name, tool, input_schema, output_schema, synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (tenant_id, integration, connection_name, tool) DO UPDATE SET
             input_schema = excluded.input_schema,
             output_schema = excluded.output_schema,
             synced_at = excluded.synced_at`,
          [
            tenantId,
            snapshot.integration,
            snapshot.connection,
            snapshot.tool,
            snapshot.inputSchema === null ? null : JSON.stringify(snapshot.inputSchema),
            snapshot.outputSchema === null ? null : JSON.stringify(snapshot.outputSchema),
            millis(snapshot.syncedAt)
          ]
        )
      }
    },

    listToolSnapshots: async (tenantId, integration) =>
      (await all(
        "SELECT * FROM gateway_tool_snapshot WHERE tenant_id = ? AND integration = ? ORDER BY connection_name, tool",
        [tenantId, integration]
      )).map(toSnapshot),

    forgetToolSnapshots: async (tenantId, keys) => {
      for (const key of keys) {
        await run(
          `DELETE FROM gateway_tool_snapshot
             WHERE tenant_id = ? AND integration = ? AND connection_name = ? AND tool = ?`,
          [tenantId, key.integration, key.connection, key.tool]
        )
      }
    },

    expireApprovals: async (at) => {
      const result = await database.execute({
        sql: `UPDATE gateway_pending_approval
                SET status = 'expired', decided_at = ?, error = 'expired before a decision was recorded'
              WHERE status = 'pending' AND expires_at <= ?`,
        args: [now(), millis(at)]
      })
      return Number(result.rowsAffected)
    },

    close: async () => {
      database.close()
    }
  }
}
