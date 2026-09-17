import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"

export const integration = sqliteTable("integration", {
  slug: text("slug").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  kind: text("kind").notNull(),
  endpoint: text("endpoint"),
  specSource: text("spec_source"),
  specFormat: text("spec_format"),
  baseUrl: text("base_url"),
  displayUrl: text("display_url"),
  authMethods: text("auth_methods").notNull().default("[]"),
  createdAt: integer("created_at").notNull()
})

export const specDocument = sqliteTable("spec_document", {
  source: text("source").primaryKey(),
  content: text("content").notNull(),
  fetchedAt: integer("fetched_at").notNull()
})

export const connection = sqliteTable("connection", {
  owner: text("owner").notNull(),
  integration: text("integration").notNull().references(() => integration.slug, { onDelete: "cascade" }),
  name: text("name").notNull(),
  template: text("template").notNull(),
  provider: text("provider").notNull(),
  identityLabel: text("identity_label"),
  description: text("description"),
  oauthClient: text("oauth_client"),
  oauthClientOwner: text("oauth_client_owner"),
  oauthScope: text("oauth_scope"),
  expiresAt: integer("expires_at"),
  createdAt: integer("created_at").notNull()
}, (table) => [
  primaryKey({ columns: [table.owner, table.integration, table.name] }),
  index("connection_by_integration").on(table.integration, table.owner)
])

export const tool = sqliteTable("tool", {
  address: text("address").primaryKey(),
  owner: text("owner").notNull(),
  integration: text("integration").notNull(),
  connection: text("connection").notNull(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  readOnly: integer("read_only").notNull().default(0),
  inputSchema: text("input_schema"),
  outputSchema: text("output_schema"),
  call: text("call").notNull(),
  capturedAt: integer("captured_at").notNull()
}, (table) => [
  index("tool_by_connection").on(table.integration, table.owner, table.connection)
])

export const oauthClient = sqliteTable("oauth_client", {
  owner: text("owner").notNull(),
  slug: text("slug").notNull(),
  integration: text("integration").notNull(),
  clientId: text("client_id").notNull(),
  authorizationUrl: text("authorization_url").notNull(),
  tokenUrl: text("token_url").notNull(),
  registrationEndpoint: text("registration_endpoint"),
  issuer: text("issuer"),
  resource: text("resource"),
  scopes: text("scopes").notNull().default("[]"),
  tokenAuthMethods: text("token_auth_methods").notNull().default("[]"),
  createdAt: integer("created_at").notNull()
}, (table) => [primaryKey({ columns: [table.owner, table.slug] })])

export const oauthFlow = sqliteTable("oauth_flow", {
  state: text("state").primaryKey(),
  owner: text("owner").notNull(),
  integration: text("integration").notNull(),
  connection: text("connection").notNull(),
  template: text("template").notNull(),
  clientOwner: text("client_owner").notNull(),
  clientSlug: text("client_slug").notNull(),
  codeVerifier: text("code_verifier").notNull(),
  redirectUri: text("redirect_uri").notNull(),
  resource: text("resource"),
  scopes: text("scopes").notNull().default("[]"),
  createdAt: integer("created_at").notNull()
})

export const credential = sqliteTable("credential", {
  key: text("key").primaryKey(),
  sealed: text("sealed").notNull()
})
