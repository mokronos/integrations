// Everything the gateway owns lives here, above the host's own database.
// Resolving a grant is what determines which subject a host instance must
// be bound to, so these rows have to be readable before that instance exists.

/** The two tables tenancy itself is built on. They exist before every other
 * statement runs, because the migration backfills rows that reference them. */
export const tenancyTableDdl = [
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
  `CREATE TABLE IF NOT EXISTS gateway_login (
     subject_id TEXT PRIMARY KEY REFERENCES gateway_subject (id) ON DELETE CASCADE,
     tenant_id TEXT NOT NULL REFERENCES gateway_tenant (id) ON DELETE CASCADE,
     email TEXT NOT NULL UNIQUE,
     password_hash TEXT,
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

export const gatewayDdl = [
  ...tenancyTableDdl,
  `CREATE TABLE IF NOT EXISTS gateway_client (
     id TEXT PRIMARY KEY,
     tenant_id TEXT NOT NULL REFERENCES gateway_tenant (id) ON DELETE CASCADE,
     name TEXT NOT NULL,
     capabilities TEXT NOT NULL,
     approval_delivery TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     revoked_at INTEGER
   )`,
  `CREATE TABLE IF NOT EXISTS gateway_external_identity (
     provider TEXT NOT NULL,
     provider_subject TEXT NOT NULL,
     subject_id TEXT NOT NULL REFERENCES gateway_subject (id) ON DELETE CASCADE,
     tenant_id TEXT NOT NULL REFERENCES gateway_tenant (id) ON DELETE CASCADE,
     email TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (provider, provider_subject)
   )`,
  `CREATE TABLE IF NOT EXISTS gateway_login_handoff (
     request_hash TEXT PRIMARY KEY,
     subject_id TEXT REFERENCES gateway_subject (id) ON DELETE CASCADE,
     tenant_id TEXT REFERENCES gateway_tenant (id) ON DELETE CASCADE,
     email TEXT,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL,
     collected_at INTEGER
   )`,
  `CREATE TABLE IF NOT EXISTS gateway_identity_oauth_state (
     state_hash TEXT PRIMARY KEY,
     provider TEXT NOT NULL,
     handoff_hash TEXT,
     return_path TEXT,
     expires_at INTEGER NOT NULL
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
export const tenantedTables = [
  "gateway_client",
  "gateway_grant",
  "gateway_pending_approval",
  "gateway_audit"
] as const
