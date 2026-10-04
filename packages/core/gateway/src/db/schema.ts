import { sql } from "drizzle-orm"
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

const createdAt = () => integer("created_at").notNull()

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

export const gatewayProfile = sqliteTable("gateway_profile", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => gatewayTenant.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  capabilities: text("capabilities").notNull(),
  approvalMethod: text("approval_method").notNull().default("elicitation"),
  mcpSurface: text("mcp_surface").notNull().default("tools"),
  approvalGroupWindowMinutes: integer("approval_group_window_minutes").notNull().default(30),
  includeNewTools: integer("include_new_tools").notNull().default(0),
  createdAt: createdAt(),
  revokedAt: integer("revoked_at")
}, (table) => [
  uniqueIndex("gateway_profile_name_tenant").on(table.tenantId, table.name)
])

/** One enabled tool on one connection, and whether its calls wait for a human. */
export const gatewayProfileTool = sqliteTable("gateway_profile_tool", {
  profileId: text("profile_id").notNull().references(() => gatewayProfile.id, { onDelete: "cascade" }),
  owner: text("owner").notNull(),
  subject: text("subject"),
  integration: text("integration").notNull(),
  connectionName: text("connection_name").notNull(),
  tool: text("tool").notNull(),
  decision: text("decision").notNull()
}, (table) => [
  primaryKey({
    columns: [
      table.profileId,
      table.owner,
      table.subject,
      table.integration,
      table.connectionName,
      table.tool
    ]
  }),
  uniqueIndex("gateway_profile_tool_route").on(
    table.profileId,
    table.owner,
    unscopedSubject,
    table.integration,
    table.connectionName,
    table.tool
  )
])

/** A saved "always approve": calls to one profile tool whose arguments fit the sealed pattern skip approval. */
export const gatewayApprovalRule = sqliteTable("gateway_approval_rule", {
  id: text("id").primaryKey(),
  profileId: text("profile_id").notNull().references(() => gatewayProfile.id, { onDelete: "cascade" }),
  owner: text("owner").notNull(),
  subject: text("subject"),
  integration: text("integration").notNull(),
  connectionName: text("connection_name").notNull(),
  tool: text("tool").notNull(),
  pattern: text("pattern").notNull(),
  createdAt: createdAt(),
  createdBy: text("created_by")
}, (table) => [
  index("gateway_approval_rule_route").on(table.profileId, table.integration, table.connectionName, table.tool)
])

export const gatewayApiKey = sqliteTable("gateway_api_key", {
  id: text("id").primaryKey(),
  profileId: text("profile_id").notNull().references(() => gatewayProfile.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  hash: text("hash").notNull().unique(),
  createdAt: createdAt(),
  lastUsedAt: integer("last_used_at"),
  revokedAt: integer("revoked_at")
})

export const gatewayOauthApplication = sqliteTable("gateway_oauth_application", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  clientIdentifier: text("client_identifier").notNull().unique(),
  name: text("name").notNull(),
  redirectUrisJson: text("redirect_uris_json").notNull(),
  metadataJson: text("metadata_json").notNull(),
  createdAt: createdAt(),
  updatedAt: integer("updated_at").notNull(),
  revokedAt: integer("revoked_at")
})

export const gatewayOauthAuthorizationRequest = sqliteTable("gateway_oauth_authorization_request", {
  id: text("id").primaryKey(),
  applicationId: text("application_id").notNull().references(() => gatewayOauthApplication.id, { onDelete: "cascade" }),
  redirectUri: text("redirect_uri").notNull(),
  state: text("state"),
  codeChallenge: text("code_challenge").notNull(),
  resource: text("resource").notNull(),
  scope: text("scope").notNull(),
  createdAt: createdAt(),
  expiresAt: integer("expires_at").notNull(),
  consumedAt: integer("consumed_at")
})

export const gatewayOauthGrant = sqliteTable("gateway_oauth_grant", {
  id: text("id").primaryKey(),
  applicationId: text("application_id").notNull().references(() => gatewayOauthApplication.id, { onDelete: "cascade" }),
  subjectId: text("subject_id").notNull().references(() => gatewaySubject.id, { onDelete: "cascade" }),
  tenantId: text("tenant_id").notNull().references(() => gatewayTenant.id, { onDelete: "cascade" }),
  profileId: text("profile_id").notNull().references(() => gatewayProfile.id, { onDelete: "cascade" }),
  resource: text("resource").notNull(),
  scope: text("scope").notNull(),
  createdAt: createdAt(),
  lastUsedAt: integer("last_used_at"),
  revokedAt: integer("revoked_at")
}, (table) => [
  uniqueIndex("gateway_oauth_grant_binding").on(
    table.applicationId, table.subjectId, table.profileId, table.resource, table.scope
  )
])

export const gatewayOauthAuthorizationCode = sqliteTable("gateway_oauth_authorization_code", {
  hash: text("hash").primaryKey(),
  grantId: text("grant_id").notNull().references(() => gatewayOauthGrant.id, { onDelete: "cascade" }),
  applicationId: text("application_id").notNull().references(() => gatewayOauthApplication.id, { onDelete: "cascade" }),
  redirectUri: text("redirect_uri").notNull(),
  codeChallenge: text("code_challenge").notNull(),
  resource: text("resource").notNull(),
  scope: text("scope").notNull(),
  createdAt: createdAt(),
  expiresAt: integer("expires_at").notNull(),
  consumedAt: integer("consumed_at")
})

export const gatewayOauthToken = sqliteTable("gateway_oauth_token", {
  hash: text("hash").primaryKey(),
  kind: text("kind").notNull(),
  familyId: text("family_id").notNull(),
  grantId: text("grant_id").notNull().references(() => gatewayOauthGrant.id, { onDelete: "cascade" }),
  applicationId: text("application_id").notNull().references(() => gatewayOauthApplication.id, { onDelete: "cascade" }),
  resource: text("resource").notNull(),
  scope: text("scope").notNull(),
  createdAt: createdAt(),
  expiresAt: integer("expires_at").notNull(),
  usedAt: integer("used_at"),
  revokedAt: integer("revoked_at"),
  replacedByHash: text("replaced_by_hash")
}, (table) => [
  index("gateway_oauth_token_family").on(table.familyId),
  index("gateway_oauth_token_grant").on(table.grantId)
])

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
  profileId: text("profile_id").notNull().references(() => gatewayProfile.id, { onDelete: "cascade" }),
  apiKeyId: text("api_key_id"),
  oauthGrantId: text("oauth_grant_id"),
  oauthApplicationId: text("oauth_application_id"),
  credentialName: text("credential_name"),
  agent: text("agent"),
  alias: text("alias").notNull(),
  tool: text("tool").notNull(),
  arguments: text("arguments").notNull(),
  argumentsLookup: text("arguments_lookup"),
  groupId: text("group_id"),
  status: text("status").notNull(),
  createdAt: createdAt(),
  expiresAt: integer("expires_at").notNull(),
  decidedAt: integer("decided_at"),
  decidedBy: text("decided_by"),
  result: text("result"),
  error: text("error"),
  collectedAt: integer("collected_at")
}, (table) => [
  index("gateway_pending_approval_retry")
    .on(
      table.tenantId,
      table.profileId,
      table.alias,
      table.tool,
      table.argumentsLookup,
      table.arguments
    )
    .where(sql`collected_at IS NULL`),
  index("gateway_pending_approval_group").on(table.groupId, table.status),
  index("gateway_pending_approval_open").on(table.profileId, table.tool, table.status)
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

export const gatewayProfileApprovalDestination = sqliteTable("gateway_profile_approval_destination", {
  profileId: text("profile_id").notNull().references(() => gatewayProfile.id, { onDelete: "cascade" }),
  destinationId: text("destination_id").notNull().references(() => gatewayApprovalDestination.id, { onDelete: "cascade" })
}, (table) => [primaryKey({ columns: [table.profileId, table.destinationId] })])

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
  profileId: text("profile_id"),
  apiKeyId: text("api_key_id"),
  oauthGrantId: text("oauth_grant_id"),
  oauthApplicationId: text("oauth_application_id"),
  credentialName: text("credential_name"),
  agent: text("agent"),
  authorizedBySubjectId: text("authorized_by_subject_id"),
  alias: text("alias"),
  tool: text("tool"),
  owner: text("owner"),
  subject: text("subject"),
  integration: text("integration"),
  connectionName: text("connection_name"),
  decision: text("decision"),
  approval: text("approval"),
  outcome: text("outcome").notNull(),
  message: text("message"),
  createdAt: createdAt()
})

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

export const gatewayOauthSession = sqliteTable("gateway_oauth_session", {
  id: text("id").primaryKey(),
  integration: text("integration").notNull(),
  connectionName: text("connection_name").notNull(),
  statusJson: text("status_json").notNull(),
  requestJson: text("request_json").notNull(),
  createdAt: createdAt()
})

export const gatewayOauthState = sqliteTable("gateway_oauth_state", {
  state: text("state").primaryKey(),
  sessionId: text("session_id").notNull(),
  createdAt: createdAt()
})
