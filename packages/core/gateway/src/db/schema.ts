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

export const gatewayAccessProfile = sqliteTable("gateway_access_profile", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => gatewayTenant.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  isDefault: integer("is_default").notNull().default(0),
  createdAt: createdAt(),
  updatedAt: integer("updated_at").notNull()
}, (table) => [
  uniqueIndex("gateway_access_profile_name_tenant").on(table.tenantId, table.name),
  uniqueIndex("gateway_access_profile_default_tenant")
    .on(table.tenantId)
    .where(sql`is_default = 1`)
])

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
  mcpSurface: text("mcp_surface").notNull().default("tools"),
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
  clientId: text("client_id").notNull().references(() => gatewayClient.id, { onDelete: "cascade" }),
  resource: text("resource").notNull(),
  scope: text("scope").notNull(),
  createdAt: createdAt(),
  lastUsedAt: integer("last_used_at"),
  revokedAt: integer("revoked_at")
}, (table) => [
  uniqueIndex("gateway_oauth_grant_binding").on(
    table.applicationId, table.subjectId, table.clientId, table.resource, table.scope
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
  oauthGrantId: text("oauth_grant_id"),
  oauthApplicationId: text("oauth_application_id"),
  authorizedBySubjectId: text("authorized_by_subject_id"),
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
