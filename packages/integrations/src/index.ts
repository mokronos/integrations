export { Integrations } from "./integrations.ts"
export type {
  AddMcpOptions,
  AddOpenApiOptions,
  CreateConnectionOptions,
  IntegrationFailure,
  ToolExecution,
  ToolFilter,
  ToolTarget
} from "./integrations.ts"
export { CatalogStore, ClientAuthMethod } from "./catalog/store.ts"
export type { ConnectionRecord, IntegrationRecord, OAuthClientRecord, OAuthFlowRecord } from "./catalog/store.ts"
export { McpClient } from "./mcp/client.ts"
export type { McpCallResult } from "./mcp/client.ts"
export { relayableInput, unrelayableInputMessage } from "./mcp/unrelayable-input.ts"
export { OAuthFlows } from "./oauth/flows.ts"
export { OpenApiInvoker } from "./openapi/invoke.ts"
export { SpecCache } from "./openapi/cache.ts"
export { classify } from "./classify.ts"
export { checkedFetch, DestinationRefused, Egress, gatewayUserAgent, platformConnect } from "./egress/egress.ts"
export type { Connect, FetchLike } from "./egress/egress.ts"
export {
  AllowedOrigin,
  defaultUrlPolicy,
  httpsOnlyUrlPolicy,
  isLoopbackHostname,
  isPrivateHostname,
  parseDestination,
  parseEndpoint,
  UrlPolicy,
  urlPolicyConfig
} from "./egress/url-policy.ts"

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
export { createEncryption, isSealed } from "./storage/encryption.ts"
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
  discoverOAuth,
  findOAuthClient,
  registerOAuthClient,
  saveOAuthClient,
  startOAuthFlow
} from "./oauth-connect.ts"
export type { ConnectionGrant, OAuthMethodSettings, OAuthSetup } from "./oauth/flows.ts"
export type { StartedOAuthFlow } from "./oauth-connect.ts"

export {
  ConnectionNotFoundError,
  DetectionError,
  IntegrationNotFoundError,
  InvalidInputError,
  InvocationError,
  McpError,
  McpFailureReason,
  OAuthError,
  SpecError,
  StorageError,
  ToolNotFoundError
} from "./errors.ts"

export { AuthTemplateSlug, gatewayOAuthClientSlug, OAuthClientSlug, OAuthState } from "./catalog/ids.ts"

export { findAuthMethod, mcpAuthMethods, openApiAuthMethods, requiresAuthentication } from "./catalog/auth-methods.ts"

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
