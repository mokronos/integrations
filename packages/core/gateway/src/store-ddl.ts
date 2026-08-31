// Everything the gateway owns lives here, above the host's own database.
// Resolving a client binding is what determines which subject a host instance must
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
     policy_id TEXT NOT NULL REFERENCES gateway_policy (id),
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
  `CREATE TABLE IF NOT EXISTS gateway_policy (
     id TEXT PRIMARY KEY,
     tenant_id TEXT NOT NULL REFERENCES gateway_tenant (id) ON DELETE CASCADE,
     name TEXT NOT NULL,
     is_default INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS gateway_policy_name_tenant
     ON gateway_policy (tenant_id, name)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS gateway_policy_default_tenant
     ON gateway_policy (tenant_id) WHERE is_default = 1`,
  `CREATE TABLE IF NOT EXISTS gateway_policy_integration (
     policy_id TEXT NOT NULL REFERENCES gateway_policy (id) ON DELETE CASCADE,
     integration TEXT NOT NULL,
     PRIMARY KEY (policy_id, integration)
   )`,
  `CREATE TABLE IF NOT EXISTS gateway_policy_tool (
     policy_id TEXT NOT NULL REFERENCES gateway_policy (id) ON DELETE CASCADE,
     owner TEXT NOT NULL,
     subject TEXT,
     integration TEXT NOT NULL,
     connection_name TEXT NOT NULL,
     tool TEXT NOT NULL,
     enabled INTEGER NOT NULL DEFAULT 1,
     decision TEXT NOT NULL,
     PRIMARY KEY (policy_id, owner, subject, integration, connection_name, tool)
   )`,
  // SQLite treats NULLs in a primary key as distinct, and an org-tier rule has
  // no subject. The expression index is what actually makes one rule per
  // (policy, connection, tool) true.
  `CREATE UNIQUE INDEX IF NOT EXISTS gateway_policy_tool_route
     ON gateway_policy_tool
        (policy_id, owner, COALESCE(subject, ''), integration, connection_name, tool)`,
  `CREATE TABLE IF NOT EXISTS gateway_client_tool_binding (
     id TEXT PRIMARY KEY,
     tenant_id TEXT NOT NULL REFERENCES gateway_tenant (id) ON DELETE CASCADE,
     client_id TEXT NOT NULL REFERENCES gateway_client (id) ON DELETE CASCADE,
     alias TEXT NOT NULL,
     tool TEXT NOT NULL,
     owner TEXT NOT NULL,
     subject TEXT,
     integration TEXT NOT NULL,
     connection_name TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     revoked_at INTEGER
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS gateway_client_tool_binding_live
     ON gateway_client_tool_binding (client_id, alias, tool) WHERE revoked_at IS NULL`,
  `CREATE TABLE IF NOT EXISTS gateway_pending_approval (
     id TEXT PRIMARY KEY,
     tenant_id TEXT NOT NULL REFERENCES gateway_tenant (id) ON DELETE CASCADE,
     client_id TEXT NOT NULL REFERENCES gateway_client (id) ON DELETE CASCADE,
     policy_id TEXT NOT NULL REFERENCES gateway_policy (id),
     binding_id TEXT NOT NULL REFERENCES gateway_client_tool_binding (id),
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
     ON gateway_pending_approval (policy_id, binding_id, arguments_lookup, arguments)
     WHERE collected_at IS NULL`,
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
  "gateway_policy",
  "gateway_client_tool_binding",
  "gateway_pending_approval",
  "gateway_audit"
] as const
