/** The integration host: one catalog of MCP endpoints and OpenAPI documents, the
 *  connections that authorize them, and one way to call a tool.
 *
 *  Wire contracts and the shared vocabulary live in `@mokronos/contracts`;
 *  import them from there rather than through this package. */

/** The Effect services. Compose these to build a host. */
export { IntegrationHost } from "./host.ts"
export type {
  AddMcpOptions,
  AddOpenApiOptions,
  CreateConnectionOptions,
  HostFailure,
  ToolFilter,
  ToolTarget
} from "./host.ts"
export { CatalogStore } from "./catalog/store.ts"
export type {
  ConnectionRecord,
  IntegrationRecord,
  OAuthClientRecord,
  OAuthFlowRecord
} from "./catalog/store.ts"
export { McpHost } from "./mcp/client.ts"
export { OAuthFlows } from "./oauth/flows.ts"
export { OpenApiInvoker } from "./openapi/invoke.ts"
export { SpecCache } from "./openapi/cache.ts"
export { HttpTransport } from "./http-transport.ts"
export { classify } from "./classify.ts"

/** The two storage seams, and the layers that satisfy them. */
export { applySchema, Database, libsqlLayer, memoryLayer, SqlValue } from "./storage/database.ts"
export type { SqlRow, SqlStatement } from "./storage/database.ts"
export {
  connectionCredentialKey,
  CredentialStore,
  oauthClientCredentialKey,
  openValue,
  sealValue,
  StoredTokens
} from "./storage/credentials.ts"

/** Layer composition. */
export { createHostRuntime, hostLayer, hostServicesOf, localLayer, stubbedLayer } from "./runtime.ts"
export type { HostServices, HostStorage } from "./runtime.ts"
export { listIntegrationOverviews } from "./overview.ts"
export { installClassified, provisionIntegration } from "./provision.ts"
export { validateIntegrationNode } from "./validate.ts"
export {
  completeOAuthFlow,
  createOAuthClient,
  probeOAuthServer,
  registerOAuthClient,
  startOAuthFlow
} from "./oauth-connect.ts"
export type { StartedOAuthFlow } from "./oauth-connect.ts"

/** Errors, so a caller matches on `_tag` rather than on message text. */
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

/** Host-internal identifiers. */
export { AuthTemplateSlug, OAuthClientSlug, OAuthState } from "./catalog/ids.ts"

/** Auth-method derivation, shared by both halves of the host. */
export {
  findAuthMethod,
  mcpAuthMethods,
  openApiAuthMethods,
  requiresAuthentication
} from "./catalog/auth-methods.ts"

/** Specification handling. */
export { compileSpec, previewOf, resolveServer } from "./openapi/compile.ts"
export type { CompiledSpec } from "./openapi/compile.ts"
export { splitArguments } from "./openapi/arguments.ts"
export { ToolCall } from "@mokronos/core-integrations"
export type { Tool } from "@mokronos/core-integrations"
export { buildRequest } from "./openapi/request.ts"
export { convertGoogleDiscovery, isGoogleDiscoveryUrl } from "./openapi/google-discovery.ts"
export { normalizeOutputSchema, normalizeToolResult } from "./mcp/result.ts"

/** The public registry. */
export { search as searchRegistry, searchIntegrations } from "./registry.ts"
export type { SearchIntegrationsOptions } from "./registry.ts"

