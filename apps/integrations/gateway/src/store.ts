import { mkdirSync } from "node:fs"
import path from "node:path"
import { createClient } from "@libsql/client"
import type { Client as LibsqlClient, InValue, Row } from "@libsql/client"
import { Schema } from "effect"
import {
  Alias,
  ApiKeyHash,
  ApiKeyId,
  ApprovalId,
  AuditId,
  canonicalArguments,
  ClientId,
  ConnectionName,
  GrantId,
  IntegrationSlug,
  SubjectId,
  ToolName
} from "./domain.ts"
import type {
  ApiKey,
  ApprovalStatus,
  AuditOutcome,
  AuditRecord,
  Client,
  ConnectionRef,
  Grant,
  GrantDecision,
  PendingApproval,
  ToolSnapshot
} from "./domain.ts"

// Everything the gateway owns lives here, above Executor's own database.
// Resolving a grant is what determines which subject an Executor instance must
// be bound to, so these rows have to be readable before that instance exists.
// See docs/adr/0001.
const ddl = [
  `CREATE TABLE IF NOT EXISTS gateway_client (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     may_mutate INTEGER NOT NULL,
     created_at INTEGER NOT NULL,
     revoked_at INTEGER
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS gateway_client_name ON gateway_client (name)`,
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
  // the uniqueness is partial rather than a plain constraint.
  `CREATE UNIQUE INDEX IF NOT EXISTS gateway_grant_live
     ON gateway_grant (client_id, alias, tool) WHERE revoked_at IS NULL`,
  `CREATE TABLE IF NOT EXISTS gateway_pending_approval (
     id TEXT PRIMARY KEY,
     client_id TEXT NOT NULL REFERENCES gateway_client (id) ON DELETE CASCADE,
     grant_id TEXT NOT NULL,
     alias TEXT NOT NULL,
     tool TEXT NOT NULL,
     arguments TEXT NOT NULL,
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
     integration TEXT NOT NULL,
     connection_name TEXT NOT NULL,
     tool TEXT NOT NULL,
     input_schema TEXT,
     output_schema TEXT,
     synced_at INTEGER NOT NULL,
     PRIMARY KEY (integration, connection_name, tool)
   )`
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
  name: Schema.String,
  may_mutate: Schema.Number,
  created_at: Schema.Number,
  revoked_at: NullableNumber
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

const clientColumns = ["id", "name", "may_mutate", "created_at", "revoked_at"]
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
const decodeApiKeyRow = Schema.decodeUnknownSync(ApiKeyRow)
const decodeGrantRow = Schema.decodeUnknownSync(GrantRow)
const decodeApprovalRow = Schema.decodeUnknownSync(ApprovalRow)
const decodeAuditRow = Schema.decodeUnknownSync(AuditRow)
const decodeSnapshotRow = Schema.decodeUnknownSync(SnapshotRow)
const decodeJson = Schema.decodeUnknownSync(Schema.Json)

const parseJsonColumn = (value: string): typeof Schema.Json.Type =>
  decodeJson(JSON.parse(value))

const date = (value: number): Date => new Date(value)
const nullableDate = (value: number | null): Date | null =>
  value === null ? null : new Date(value)
const millis = (value: Date): number => value.getTime()

const toClient = (row: Row): Client => {
  const decoded = decodeClientRow(pick(row, clientColumns))
  return {
    id: ClientId.make(decoded.id),
    name: decoded.name,
    mayMutate: decoded.may_mutate !== 0,
    createdAt: date(decoded.created_at),
    revokedAt: nullableDate(decoded.revoked_at)
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

const toApproval = (row: Row): PendingApproval => {
  const decoded = decodeApprovalRow(pick(row, approvalColumns))
  return {
    id: ApprovalId.make(decoded.id),
    clientId: ClientId.make(decoded.client_id),
    grantId: GrantId.make(decoded.grant_id),
    alias: Alias.make(decoded.alias),
    tool: ToolName.make(decoded.tool),
    arguments: parseJsonColumn(decoded.arguments),
    status: decoded.status,
    createdAt: date(decoded.created_at),
    expiresAt: date(decoded.expires_at),
    decidedAt: nullableDate(decoded.decided_at),
    decidedBy: decoded.decided_by,
    result: decoded.result === null ? null : parseJsonColumn(decoded.result),
    error: decoded.error,
    collectedAt: nullableDate(decoded.collected_at)
  }
}

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

export interface CreateClientInput {
  readonly id: ClientId
  readonly name: string
  readonly mayMutate: boolean
}

export interface CreateGrantInput {
  readonly id: GrantId
  readonly clientId: ClientId
  readonly alias: Alias
  readonly tool: ToolName
  readonly connection: ConnectionRef
  readonly decision: GrantDecision
}

export interface CreateApprovalInput {
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

  createClient(input: CreateClientInput): Promise<Client>
  listClients(): Promise<ReadonlyArray<Client>>
  findClientById(id: ClientId): Promise<Client | undefined>
  findClientByName(name: string): Promise<Client | undefined>
  revokeClient(id: ClientId): Promise<void>

  addApiKey(input: { readonly id: ApiKeyId; readonly clientId: ClientId; readonly hash: ApiKeyHash }): Promise<ApiKey>
  listApiKeys(clientId: ClientId): Promise<ReadonlyArray<ApiKey>>
  findApiKeyByHash(hash: ApiKeyHash): Promise<ApiKey | undefined>
  touchApiKey(id: ApiKeyId): Promise<void>
  revokeApiKey(id: ApiKeyId): Promise<void>

  createGrant(input: CreateGrantInput): Promise<Grant>
  listGrants(clientId: ClientId): Promise<ReadonlyArray<Grant>>
  findGrant(clientId: ClientId, alias: Alias, tool: ToolName): Promise<Grant | undefined>
  revokeGrant(id: GrantId): Promise<void>

  createApproval(input: CreateApprovalInput): Promise<PendingApproval>
  getApproval(id: ApprovalId): Promise<PendingApproval | undefined>
  listApprovals(status?: ApprovalStatus): Promise<ReadonlyArray<PendingApproval>>
  /** The frozen call a retry of these arguments belongs to, if one is still
   *  undelivered. This is what makes a retrying step ask a human once. */
  findUncollectedApproval(
    grantId: GrantId,
    argumentsValue: Schema.Json
  ): Promise<PendingApproval | undefined>
  /** Hands a settled approval's outcome to the caller, once. Returns false if
   *  another attempt collected it first, so concurrent retries cannot both
   *  claim the same decision. */
  collectApproval(id: ApprovalId): Promise<boolean>
  settleApproval(input: {
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
  listAudit(options: AuditQuery): Promise<ReadonlyArray<AuditRecord>>
  countAudit(options: Omit<AuditQuery, "limit" | "offset">): Promise<number>
  expireAuditArguments(now: Date): Promise<number>

  putToolSnapshots(snapshots: ReadonlyArray<ToolSnapshot>): Promise<void>
  listToolSnapshots(integration: IntegrationSlug): Promise<ReadonlyArray<ToolSnapshot>>
  forgetToolSnapshots(
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
  return {
    where: clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`,
    args
  }
}

export const createGatewayStore = async (databasePath: string): Promise<GatewayStore> => {
  mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 })
  const database: LibsqlClient = createClient({ url: `file:${databasePath}` })
  await database.execute("PRAGMA journal_mode = WAL")
  await database.execute("PRAGMA foreign_keys = ON")
  // `CREATE TABLE IF NOT EXISTS` does nothing for a database that already
  // exists, so a column added after the fact has to be added explicitly — and
  // before the DDL below, which indexes it. A gateway that has been running
  // since before delivery-once tracking must not have to be deleted to get it.
  await addMissingColumns(database, "gateway_pending_approval", {
    collected_at: "INTEGER"
  })
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

  return {
    databasePath,

    createClient: async (input) => {
      await run(
        "INSERT INTO gateway_client (id, name, may_mutate, created_at, revoked_at) VALUES (?, ?, ?, ?, NULL)",
        [input.id, input.name, input.mayMutate ? 1 : 0, now()]
      )
      return await requireClient(input.id)
    },

    listClients: async () =>
      (await all("SELECT * FROM gateway_client ORDER BY created_at", [])).map(toClient),

    findClientById: async (id) => {
      const row = await one("SELECT * FROM gateway_client WHERE id = ?", [id])
      return row === undefined ? undefined : toClient(row)
    },

    findClientByName: async (name) => {
      const row = await one("SELECT * FROM gateway_client WHERE name = ?", [name])
      return row === undefined ? undefined : toClient(row)
    },

    revokeClient: async (id) => {
      await run("UPDATE gateway_client SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", [now(), id])
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
      const row = await one("SELECT * FROM gateway_api_key WHERE hash = ?", [hash])
      return row === undefined ? undefined : toApiKey(row)
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
           (id, client_id, alias, tool, owner, subject, integration, connection_name, decision, created_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        [
          input.id,
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

    revokeGrant: async (id) => {
      await run("UPDATE gateway_grant SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", [now(), id])
    },

    createApproval: async (input) => {
      await run(
        `INSERT INTO gateway_pending_approval
           (id, client_id, grant_id, alias, tool, arguments, status, created_at, expires_at, decided_at, decided_by, result, error, collected_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL, NULL, NULL, NULL, NULL)`,
        [
          input.id,
          input.clientId,
          input.grantId,
          input.alias,
          input.tool,
          // Stored canonically so that the same request, however its JSON was
          // built, matches the frozen call it is a retry of.
          canonicalArguments(input.arguments),
          now(),
          millis(input.expiresAt)
        ]
      )
      const row = await one("SELECT * FROM gateway_pending_approval WHERE id = ?", [input.id])
      if (row === undefined) throw new Error(`Failed to store approval ${input.id}`)
      return toApproval(row)
    },

    findUncollectedApproval: async (grantId, argumentsValue) => {
      const row = await one(
        `SELECT * FROM gateway_pending_approval
          WHERE grant_id = ? AND arguments = ? AND collected_at IS NULL
          ORDER BY created_at DESC LIMIT 1`,
        [grantId, canonicalArguments(argumentsValue)]
      )
      return row === undefined ? undefined : toApproval(row)
    },

    collectApproval: async (id) => {
      const result = await database.execute({
        sql: `UPDATE gateway_pending_approval
                SET collected_at = ?
              WHERE id = ? AND collected_at IS NULL AND status <> 'pending'`,
        args: [now(), id]
      })
      return Number(result.rowsAffected) > 0
    },

    getApproval: async (id) => {
      const row = await one("SELECT * FROM gateway_pending_approval WHERE id = ?", [id])
      return row === undefined ? undefined : toApproval(row)
    },

    listApprovals: async (status) =>
      (status === undefined
        ? await all("SELECT * FROM gateway_pending_approval ORDER BY created_at DESC", [])
        : await all(
          "SELECT * FROM gateway_pending_approval WHERE status = ? ORDER BY created_at DESC",
          [status]
        )).map(toApproval),

    settleApproval: async (input) => {
      await run(
        `UPDATE gateway_pending_approval
           SET status = ?, decided_at = ?, decided_by = ?, result = ?, error = ?
         WHERE id = ? AND status = 'pending'`,
        [
          input.status,
          now(),
          input.decidedBy,
          input.result === null ? null : JSON.stringify(input.result),
          input.error,
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
           (id, client_id, alias, tool, owner, subject, integration, connection_name, decision, outcome, message, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.id,
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
          [input.id, JSON.stringify(input.arguments.value), millis(input.arguments.expiresAt)]
        )
      }
    },

    listAudit: async (options) => {
      const filter = auditFilter(options)
      return (await all(
        `SELECT * FROM gateway_audit${filter.where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
        [...filter.args, options.limit ?? 50, options.offset ?? 0]
      )).map(toAuditRecord)
    },

    countAudit: async (options) => {
      const filter = auditFilter(options)
      const row = await one(
        `SELECT COUNT(*) AS total FROM gateway_audit${filter.where}`,
        filter.args
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

    putToolSnapshots: async (snapshots) => {
      for (const snapshot of snapshots) {
        await run(
          `INSERT INTO gateway_tool_snapshot
             (integration, connection_name, tool, input_schema, output_schema, synced_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (integration, connection_name, tool) DO UPDATE SET
             input_schema = excluded.input_schema,
             output_schema = excluded.output_schema,
             synced_at = excluded.synced_at`,
          [
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

    listToolSnapshots: async (integration) =>
      (await all(
        "SELECT * FROM gateway_tool_snapshot WHERE integration = ? ORDER BY connection_name, tool",
        [integration]
      )).map(toSnapshot),

    forgetToolSnapshots: async (keys) => {
      for (const key of keys) {
        await run(
          `DELETE FROM gateway_tool_snapshot
             WHERE integration = ? AND connection_name = ? AND tool = ?`,
          [key.integration, key.connection, key.tool]
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
