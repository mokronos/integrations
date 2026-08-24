export { gatewayDatabasePath, integrationsHome } from "./paths.ts"
export { createGateway } from "./host.ts"
export type { Gateway } from "./host.ts"

export {
  Alias,
  ApiKey,
  ApiKeyHash,
  ApiKeyId,
  ApprovalDelivery,
  ApprovalId,
  ApprovalStatus,
  AuditArguments,
  AuditId,
  AuditOutcome,
  AuditRecord,
  Authorization,
  Client,
  ClientCapability,
  ClientId,
  clientHasCapability,
  connectionSubject,
  ConnectionName,
  ConnectionRef,
  defaultApprovalDelivery,
  defaultTenantId,
  describeAuthorization,
  DriftEntry,
  DriftKind,
  ExternalIdentity,
  Grant,
  GrantDecision,
  GrantId,
  IntegrationSlug,
  IdentityProvider,
  Login,
  LoginHandoff,
  OwnerTier,
  PendingApproval,
  Subject,
  SubjectId,
  Tenant,
  TenantId,
  ToolName,
  ToolSnapshot
} from "./domain.ts"

export { ApprovalNotification, deliverApprovalNotification } from "./approval-delivery.ts"
export type { ApprovalDeliveryInput } from "./approval-delivery.ts"

export {
  generateApiKey,
  generateLoginHandoff,
  hashApiKey,
  hashLoginHandoff,
  newApprovalId,
  newAuditId,
  newClientId,
  newGrantId,
  newSubjectId,
  newTenantId
} from "./keys.ts"
export type { IssuedApiKey, IssuedLoginHandoff } from "./keys.ts"

export {
  createGatewayStore,
  GatewayStoreInitializationError,
  GatewayStoreService
} from "./store.ts"
export type {
  CreateApprovalInput,
  CreateClientInput,
  CreateGrantInput,
  CreateSubjectInput,
  CreateTenantInput,
  GatewayStore,
  GatewayOverviewCounts,
  GatewayStoreOptions,
  RecordAuditInput
} from "./store.ts"

export {
  authenticateClient,
  authorizeClientCapability,
  authorizeInvocation
} from "./authorize.ts"
export type { CapabilityAuthorization, ClientAuthentication } from "./authorize.ts"

export {
  defaultApprovalExpiryHours,
  defaultArgumentRetentionDays,
  defaultGatewayPort,
  gatewayConfigPath,
  GatewayConfigFile,
  readGatewayConfig,
  resolveClientConnection,
  writeGatewayConfig
} from "./config.ts"
export type { ClientConnection } from "./config.ts"

export {
  executeAuthorized,
  grantToolAddress,
  invokeThroughGateway,
  listGrantedTools
} from "./invoke.ts"
export type { InvocationOutcome, InvokeDependencies } from "./invoke.ts"

export { diffSnapshots, refreshIntegrationSnapshot } from "./drift.ts"
export type { ToolCatalogReader } from "./drift.ts"
export type { DriftReport } from "./drift.ts"
export { runMaintenance, startMaintenanceLoop } from "./maintenance.ts"
export type { MaintenanceLoop, MaintenanceResult } from "./maintenance.ts"
export { createEncryption, resolveEncryption } from "./crypto.ts"
export type { Encryption, EncryptionSource } from "./crypto.ts"
export { createRateLimiter } from "./ratelimit.ts"
export type { RateLimiter, RateLimiterOptions, RateLimitDecision } from "./ratelimit.ts"
export { createOAuthSessions } from "./oauth-sessions.ts"
export type {
  OAuthSession,
  OAuthSessionStore,
  OAuthSessions,
  OAuthSessionsOptions,
  OAuthSessionState
} from "./oauth-sessions.ts"
export { authorizeInBrowser, oauthBrowserPage, startHostedAuthorization } from "./oauth.ts"
export type { HostedAuthorization, HostedAuthorizationFlow } from "./oauth.ts"

export { gatewayRoutes } from "./http/api.ts"
export type { ApiDependencies } from "./http/api.ts"
export { createGatewayHandler } from "./http/handler.ts"
export type { GatewayRequestContext } from "./http/handler.ts"
export {
  isLoopbackAddress,
  isLoopbackHostHeader,
  mayBorrowLocalCredential
} from "./http/loopback.ts"
export type { LoopbackBootstrap } from "./http/loopback.ts"
export { createWebAssets } from "./web-assets.ts"
export type { WebAssets, WebAssetsOptions } from "./web-assets.ts"
export { matchRoute } from "./http/router.ts"
export type { Route, RouteAccess, RouteRequest, RouteResult } from "./http/router.ts"

export {
  createGatewayService,
  ensureLocalCredential,
  localClientName,
  serveGateway
} from "./service.ts"
export type {
  GatewayService,
  GatewayServiceOptions,
  RunningGateway,
  ServeOptions
} from "./service.ts"

// Re-exported so consumers compose the host through the gateway rather than
// reaching for the host package directly. The host package is an internal
// dependency of the gateway from here on.
export {
  createHostHandle,
  createIntegrationsApi,
  HostHandleService,
  IntegrationsApiService
} from "@mokronos/integration-host"
export type {
  HostHandle,
  IntegrationsApi
} from "@mokronos/integration-host"
