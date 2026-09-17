export { Integrations } from "./integrations.ts"
export type {
  AddMcpOptions,
  AddOpenApiOptions,
  CreateConnectionOptions,
  IntegrationFailure,
  ToolFilter,
  ToolTarget
} from "./integrations.ts"
export { CatalogStore } from "./catalog/store.ts"
export type {
  ConnectionRecord,
  IntegrationRecord,
  OAuthClientRecord,
  OAuthFlowRecord
} from "./catalog/store.ts"
export { McpClient } from "./mcp/client.ts"
export { OAuthFlows } from "./oauth/flows.ts"
export { OpenApiInvoker } from "./openapi/invoke.ts"
export { SpecCache } from "./openapi/cache.ts"
export { classify } from "./classify.ts"

export { BlobStore } from "./storage/blobs.ts"
export type { BlobMetadata, StoredBlob } from "./storage/blobs.ts"
export { Database, SqlValue } from "./storage/database.ts"
export type { SqlRow, SqlStatement } from "./storage/database.ts"
export {
  connectionCredentialKey,
  CredentialStore,
  oauthClientCredentialKey,
  StoredTokens
} from "./storage/credentials.ts"
export { createEncryption } from "./storage/encryption.ts"
export type { Encryption } from "./storage/encryption.ts"
export { applyMigrations } from "./storage/migrate.ts"
export type { Migration, MigrationSet } from "./storage/migrate.ts"

export {
  applyIntegrationMigrations,
  integrationLayer,
  integrationMigrationSet,
  temporarySqlLayer,
  stubbedLayer,
  unavailableHttpClientLayer
} from "./runtime.ts"
export type { IntegrationLayerOptions, IntegrationServices } from "./runtime.ts"
export { listIntegrationOverviews } from "./overview.ts"
export { installClassified, provisionIntegration } from "./provision.ts"
export { validateIntegrationNode } from "./validate.ts"
export {
  completeOAuthFlow,
  createOAuthClient,
  findOAuthClient,
  probeOAuthServer,
  registerOAuthClient,
  startOAuthFlow
} from "./oauth-connect.ts"
export type { StartedOAuthFlow } from "./oauth-connect.ts"

export {
  ConnectionNotFoundError,
  DetectionError,
  IntegrationNotFoundError,
  InvalidInputError,
  InvocationError,
  McpError,
  OAuthError,
  SpecError,
  StorageError,
  ToolNotFoundError
} from "./errors.ts"

export { AuthTemplateSlug, OAuthClientSlug, OAuthState } from "./catalog/ids.ts"

export {
  findAuthMethod,
  mcpAuthMethods,
  openApiAuthMethods,
  requiresAuthentication
} from "./catalog/auth-methods.ts"

export { compileSpec, previewOf, resolveServer } from "./openapi/compile.ts"
export type { CompiledSpec } from "./openapi/compile.ts"
export { splitArguments } from "./openapi/arguments.ts"
export { ToolCall } from "./tool.ts"
export type { Tool } from "./tool.ts"
export { buildRequest } from "./openapi/request.ts"
export { convertGoogleDiscovery, isGoogleDiscoveryUrl } from "./openapi/google-discovery.ts"
export { normalizeOutputSchema, normalizeToolResult } from "./mcp/result.ts"

export { search as searchRegistry, searchIntegrations } from "./registry.ts"
export type { SearchIntegrationsOptions } from "./registry.ts"
