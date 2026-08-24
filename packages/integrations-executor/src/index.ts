/** The gateway's integration host: one catalog of MCP endpoints and OpenAPI
 *  documents, the connections that authorize them, and one way to call a tool.
 *
 *  Wire contracts live in `@mokronos/integrations-protocol` and are re-exported
 *  here so a caller needs one import. */
export {
  decodeIntegrationsResponse,
  errorPayloadMessage,
  ExecutorAuthMethod,
  ExecutorAuthPlacement,
  ExecutorConnection,
  ExecutorDetection,
  ExecutorIntegration,
  ExecutorMcpProbe,
  ExecutorOpenApiPreview,
  ExecutorOAuthProbe,
  ExecutorOAuthStart,
  ExecutorOwner,
  ExecutorTool,
  ExecutorToolAddress,
  ExecutorToolSummary,
  IntegrationOverview,
  IntegrationsResponse
} from "./schemas.ts"

/** The Promise-facing boundary the gateway, CLI and dashboard consume. */
export {
  createExecutorServices,
  ExecutorServicesService
} from "./executor-services.ts"
export type {
  ExecutorAuth,
  ExecutorCatalog,
  ExecutorConnections,
  ExecutorServices,
  ExecutorToolFilter,
  ExecutorTools,
  ExecutorToolTarget
} from "./executor-services.ts"

export {
  createExecutorHost,
  ExecutorHostClosedError,
  ExecutorHostService
} from "./host.ts"
export type { ExecutorHost, ExecutorHostStorage, HostServices } from "./host.ts"

/** The Effect-native services, for a caller composing its own layer graph — a
 *  Cloudflare worker replacing storage, or a test replacing the network. */
export { CatalogStore } from "./catalog-store.ts"
export type {
  ConnectionRecord,
  IntegrationRecord,
  OAuthClientRecord,
  OAuthFlowRecord
} from "./catalog-store.ts"
export {
  connectionCredentialKey,
  CredentialKey,
  CredentialStore,
  oauthClientCredentialKey,
  openValue,
  sealValue,
  StoredTokens
} from "./credentials.ts"
export { applySchema, Database, libsqlLayer, memoryLayer, SqlValue } from "./database.ts"
export type { SqlRow, SqlStatement } from "./database.ts"
export { IntegrationHost } from "./integration-host.ts"
export type { HostFailure, ToolFilter, ToolTarget } from "./integration-host.ts"
export { McpHost } from "./mcp.ts"
export { OAuthFlows } from "./oauth.ts"
export { OpenApiInvoker } from "./openapi-invoke.ts"
export { SpecCache } from "./spec-cache.ts"
export { capabilitiesLayer, hostLayer, localLayer, testLayer } from "./runtime.ts"

/** Errors, so a caller can match on `_tag` rather than on message text. */
export {
  ConnectionNotFoundError,
  DetectionError,
  HostError,
  IntegrationNotFoundError,
  InvalidInputError,
  InvocationError,
  McpError,
  OAuthError,
  SpecError,
  StorageError,
  ToolNotFoundError
} from "./errors.ts"

/** Identifiers. Branded so a slug cannot stand in for a connection name. */
export {
  AuthTemplateSlug,
  ConnectionAddress,
  connectionAddress,
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
  OAuthState,
  parseToolAddress,
  slugify,
  toolAddress,
  ToolName
} from "./ids.ts"
export type { ParsedToolAddress } from "./ids.ts"

/** Auth-method derivation, shared by both halves of the host. */
export {
  findAuthMethod,
  mcpAuthMethods,
  noAuthMethod,
  openApiAuthMethods,
  requiresAuthentication
} from "./auth-templates.ts"

/** Integration-facing projections. */
export type {
  DiscoverIntegrationsOptions,
  IntegrationDiscovery,
  IntegrationInspection,
  IntegrationKind,
  IntegrationNodeConfig,
  IntegrationValidationFinding,
  IntegrationValidationReport
} from "./integration-model.ts"
export {
  IntegrationDiscovery as IntegrationDiscoverySchema,
  IntegrationInspection as IntegrationInspectionSchema,
  IntegrationKind as IntegrationKindSchema,
  IntegrationNodeConfig as IntegrationNodeConfigSchema,
  IntegrationValidationFinding as IntegrationValidationFindingSchema,
  IntegrationValidationReport as IntegrationValidationReportSchema
} from "./integration-model.ts"
export { createIntegrationDiscovery } from "./discovery.ts"
export type { IntegrationDiscoveryDependencies } from "./discovery.ts"
export { createIntegrationOverview } from "./overview.ts"
export type { IntegrationOverviewDependencies } from "./overview.ts"
export { createIntegrationProvisioning } from "./provisioning.ts"
export type { IntegrationProvisioningDependencies } from "./provisioning.ts"
export { createIntegrationValidation } from "./validation.ts"
export type { IntegrationValidationDependencies } from "./validation.ts"

/** The public registry. */
export {
  search as searchRegistry,
  IntegrationSearchKind as IntegrationSearchKindSchema,
  IntegrationSearchMatch as IntegrationSearchMatchSchema,
  IntegrationSearchQuery as IntegrationSearchQuerySchema,
  IntegrationSearchResponse as IntegrationSearchResponseSchema,
  IntegrationSearchSurface as IntegrationSearchSurfaceSchema,
  searchIntegrations
} from "./registry.ts"
export type {
  IntegrationSearchKind,
  IntegrationSearchMatch,
  IntegrationSearchQuery,
  IntegrationSearchResponse,
  IntegrationSearchSurface,
  SearchIntegrationsOptions
} from "./registry.ts"

/** Specification handling, exposed for the tools that inspect documents. */
export { compileSpec, previewOf, resolveServer, splitInput } from "./openapi.ts"
export type { CompiledOperation, CompiledSpec, CompiledSecurityScheme } from "./openapi.ts"
export { convertGoogleDiscovery, isGoogleDiscoveryUrl } from "./google-discovery.ts"
export { normalizeOutputSchema, normalizeToolResult } from "./tool-result.ts"
