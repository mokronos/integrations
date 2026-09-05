// Everything the gateway owns lives here, above the host's own database.
// Resolving a client's grant is what determines which subject a host instance
// must be bound to, so these rows have to be readable before that instance
// exists.
//
// This is the whole schema and the single place it is declared. Drizzle is here
// for exactly one job: `bun run db:generate` diffs this file against the last
// snapshot and writes the SQL that carries a live database from that shape to
// this one. Nothing imports this module at runtime — the generated statements
// are embedded in `src/store-migrations.gen.ts` and applied through the same
// libsql-shaped client the store queries, so a D1 binding runs the same
// migrations as a local file without drizzle in the bundle.
//
// Hand-editing the generated SQL defeats the snapshot: change a shape here,
// regenerate, and commit both.

import { sql } from "drizzle-orm"
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

const createdAt = () => integer("created_at").notNull()

// The route a tool grant lives on, with a null `subject` folded onto one value
// so the engine can see two unscoped grants for the same route as one key.
//
// Written as a CASE rather than `COALESCE(subject, '')` because drizzle-kit
// squashes an index's columns into a comma-separated string and splits it back
// out again: an expression containing a comma comes out the far side as two
// mangled column names. A comma-free expression round-trips intact.
const unscopedSubject = sql`CASE WHEN subject IS NULL THEN '' ELSE subject END`

export const gatewayTenant = sqliteTable("gateway_tenant", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  createdAt: createdAt()
})

export const gatewaySubject = sqliteTable("gateway_subject", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => gatewayTenant.id, { onDelete: "cascade" }),
  createdAt: createdAt()
})

export const gatewayLogin = sqliteTable("gateway_login", {
  subjectId: text("subject_id").primaryKey().references(() => gatewaySubject.id, {
    onDelete: "cascade"
  }),
  tenantId: text("tenant_id").notNull().references(() => gatewayTenant.id, { onDelete: "cascade" }),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash"),
  createdAt: createdAt()
})

export const gatewaySession = sqliteTable("gateway_session", {
  tokenHash: text("token_hash").primaryKey(),
  subjectId: text("subject_id").notNull().references(() => gatewaySubject.id, {
    onDelete: "cascade"
  }),
  tenantId: text("tenant_id").notNull().references(() => gatewayTenant.id, { onDelete: "cascade" }),
  createdAt: createdAt(),
  expiresAt: integer("expires_at").notNull()
})

// A profile names the tools a client may reach; a policy names which of them
// stop for a human. Both are tenant-owned and reusable, so each client carries
// one of each rather than its own copy of either.
export const gatewayAccessProfile = sqliteTable("gateway_access_profile", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => gatewayTenant.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  isDefault: integer("is_default").notNull().default(0),
  createdAt: createdAt(),
  updatedAt: integer("updated_at").notNull()
}, (table) => [
  uniqueIndex("gateway_access_profile_name_tenant").on(table.tenantId, table.name),
  // One default per tenant, enforced by the engine rather than by whoever
  // remembers to clear the old flag first.
  uniqueIndex("gateway_access_profile_default_tenant")
    .on(table.tenantId)
    .where(sql`is_default = 1`)
])

// `subject` is null for a connection that is not subject-scoped. SQLite counts
// distinct nulls as distinct keys, so the primary key alone would admit two
// rows for the same unscoped route; the coalescing index is what actually makes
// a route unique.
export const gatewayAccessProfileTool = sqliteTable("gateway_access_profile_tool", {
  accessProfileId: text("access_profile_id").notNull().references(
    () => gatewayAccessProfile.id,
    { onDelete: "cascade" }
  ),
  owner: text("owner").notNull(),
  subject: text("subject"),
  integration: text("integration").notNull(),
  connectionName: text("connection_name").notNull(),
  tool: text("tool").notNull()
}, (table) => [
  primaryKey({
    columns: [
      table.accessProfileId,
      table.owner,
      table.subject,
      table.integration,
      table.connectionName,
      table.tool
    ]
  }),
  uniqueIndex("gateway_access_profile_tool_route").on(
    table.accessProfileId,
    table.owner,
    unscopedSubject,
    table.integration,
    table.connectionName,
    table.tool
  )
])

export const gatewayApprovalPolicy = sqliteTable("gateway_approval_policy", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => gatewayTenant.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  isDefault: integer("is_default").notNull().default(0),
  createdAt: createdAt(),
  updatedAt: integer("updated_at").notNull()
}, (table) => [
  uniqueIndex("gateway_approval_policy_name_tenant").on(table.tenantId, table.name),
  uniqueIndex("gateway_approval_policy_default_tenant")
    .on(table.tenantId)
    .where(sql`is_default = 1`)
])

export const gatewayApprovalPolicyTool = sqliteTable("gateway_approval_policy_tool", {
  approvalPolicyId: text("approval_policy_id").notNull().references(
    () => gatewayApprovalPolicy.id,
    { onDelete: "cascade" }
  ),
  owner: text("owner").notNull(),
  subject: text("subject"),
  integration: text("integration").notNull(),
  connectionName: text("connection_name").notNull(),
  tool: text("tool").notNull(),
  decision: text("decision").notNull()
}, (table) => [
  primaryKey({
    columns: [
      table.approvalPolicyId,
      table.owner,
      table.subject,
      table.integration,
      table.connectionName,
      table.tool
    ]
  }),
  uniqueIndex("gateway_approval_policy_tool_route").on(
    table.approvalPolicyId,
    table.owner,
    unscopedSubject,
    table.integration,
    table.connectionName,
    table.tool
  )
])

export const gatewayClient = sqliteTable("gateway_client", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => gatewayTenant.id, { onDelete: "cascade" }),
  accessProfileId: text("access_profile_id").notNull().references(() => gatewayAccessProfile.id),
  approvalPolicyId: text("approval_policy_id").notNull().references(() => gatewayApprovalPolicy.id),
  name: text("name").notNull(),
  capabilities: text("capabilities").notNull(),
  approvalDelivery: text("approval_delivery").notNull(),
  createdAt: createdAt(),
  revokedAt: integer("revoked_at")
}, (table) => [
  uniqueIndex("gateway_client_name_tenant").on(table.tenantId, table.name)
])

export const gatewayApiKey = sqliteTable("gateway_api_key", {
  id: text("id").primaryKey(),
  clientId: text("client_id").notNull().references(() => gatewayClient.id, { onDelete: "cascade" }),
  hash: text("hash").notNull().unique(),
  createdAt: createdAt(),
  lastUsedAt: integer("last_used_at"),
  revokedAt: integer("revoked_at")
})

export const gatewayExternalIdentity = sqliteTable("gateway_external_identity", {
  provider: text("provider").notNull(),
  providerSubject: text("provider_subject").notNull(),
  subjectId: text("subject_id").notNull().references(() => gatewaySubject.id, {
    onDelete: "cascade"
  }),
  tenantId: text("tenant_id").notNull().references(() => gatewayTenant.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  createdAt: createdAt()
}, (table) => [
  primaryKey({ columns: [table.provider, table.providerSubject] })
])

export const gatewayLoginHandoff = sqliteTable("gateway_login_handoff", {
  requestHash: text("request_hash").primaryKey(),
  subjectId: text("subject_id").references(() => gatewaySubject.id, { onDelete: "cascade" }),
  tenantId: text("tenant_id").references(() => gatewayTenant.id, { onDelete: "cascade" }),
  email: text("email"),
  createdAt: createdAt(),
  expiresAt: integer("expires_at").notNull(),
  collectedAt: integer("collected_at")
})

export const gatewayIdentityOauthState = sqliteTable("gateway_identity_oauth_state", {
  stateHash: text("state_hash").primaryKey(),
  provider: text("provider").notNull(),
  handoffHash: text("handoff_hash"),
  returnPath: text("return_path"),
  expiresAt: integer("expires_at").notNull()
})

export const gatewayPendingApproval = sqliteTable("gateway_pending_approval", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => gatewayTenant.id, { onDelete: "cascade" }),
  clientId: text("client_id").notNull().references(() => gatewayClient.id, { onDelete: "cascade" }),
  approvalPolicyId: text("approval_policy_id").notNull().references(() => gatewayApprovalPolicy.id),
  accessProfileId: text("access_profile_id").notNull().references(() => gatewayAccessProfile.id),
  alias: text("alias").notNull(),
  tool: text("tool").notNull(),
  arguments: text("arguments").notNull(),
  argumentsLookup: text("arguments_lookup"),
  status: text("status").notNull(),
  createdAt: createdAt(),
  expiresAt: integer("expires_at").notNull(),
  decidedAt: integer("decided_at"),
  decidedBy: text("decided_by"),
  result: text("result"),
  error: text("error"),
  collectedAt: integer("collected_at")
}, (table) => [
  // A retried invocation looks up the approval a human already answered, so the
  // index covers the whole identity of a frozen call and skips the rows whose
  // answer has been collected.
  index("gateway_pending_approval_retry")
    .on(
      table.tenantId,
      table.clientId,
      table.alias,
      table.approvalPolicyId,
      table.accessProfileId,
      table.tool,
      table.argumentsLookup,
      table.arguments
    )
    .where(sql`collected_at IS NULL`)
])

export const gatewayApprovalDestination = sqliteTable("gateway_approval_destination", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => gatewayTenant.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  type: text("type").notNull(),
  url: text("url").notNull(),
  signingSecret: text("signing_secret").notNull(),
  createdAt: createdAt(),
  deletedAt: integer("deleted_at")
}, (table) => [
  uniqueIndex("gateway_approval_destination_name_tenant").on(table.tenantId, table.name)
])

export const gatewayClientApprovalDestination = sqliteTable("gateway_client_approval_destination", {
  clientId: text("client_id").notNull().references(() => gatewayClient.id, { onDelete: "cascade" }),
  destinationId: text("destination_id").notNull().references(() => gatewayApprovalDestination.id, { onDelete: "cascade" })
}, (table) => [primaryKey({ columns: [table.clientId, table.destinationId] })])

export const gatewayApprovalDelivery = sqliteTable("gateway_approval_delivery", {
  id: text("id").primaryKey(),
  approvalId: text("approval_id").notNull().references(() => gatewayPendingApproval.id, { onDelete: "cascade" }),
  destinationId: text("destination_id").notNull().references(() => gatewayApprovalDestination.id),
  status: text("status").notNull(),
  attempts: integer("attempts").notNull(),
  nextAttemptAt: integer("next_attempt_at"),
  deliveredAt: integer("delivered_at"),
  lastError: text("last_error")
}, (table) => [
  uniqueIndex("gateway_approval_delivery_once").on(table.approvalId, table.destinationId),
  index("gateway_approval_delivery_due").on(table.status, table.nextAttemptAt)
])

export const gatewayAudit = sqliteTable("gateway_audit", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => gatewayTenant.id, { onDelete: "cascade" }),
  clientId: text("client_id"),
  alias: text("alias"),
  tool: text("tool"),
  owner: text("owner"),
  subject: text("subject"),
  integration: text("integration"),
  connectionName: text("connection_name"),
  decision: text("decision"),
  outcome: text("outcome").notNull(),
  message: text("message"),
  createdAt: createdAt()
})

// Audited arguments are caller data, so they expire on their own schedule
// rather than living as long as the audit row that points at them.
export const gatewayAuditArguments = sqliteTable("gateway_audit_arguments", {
  auditId: text("audit_id").primaryKey().references(() => gatewayAudit.id, { onDelete: "cascade" }),
  arguments: text("arguments").notNull(),
  expiresAt: integer("expires_at").notNull()
})

export const gatewayToolSnapshot = sqliteTable("gateway_tool_snapshot", {
  tenantId: text("tenant_id").notNull().references(() => gatewayTenant.id, { onDelete: "cascade" }),
  integration: text("integration").notNull(),
  connectionName: text("connection_name").notNull(),
  tool: text("tool").notNull(),
  inputSchema: text("input_schema"),
  outputSchema: text("output_schema"),
  syncedAt: integer("synced_at").notNull()
}, (table) => [
  primaryKey({
    columns: [table.tenantId, table.integration, table.connectionName, table.tool]
  })
])
