export { gatewayDatabasePath, integrationsHome } from "./paths.ts"
export { createGateway } from "./host.ts"
export type { Gateway } from "./host.ts"

export {
  Alias,
  ApiKey,
  ApiKeyHash,
  ApiKeyId,
  ApprovalId,
  ApprovalStatus,
  AuditArguments,
  AuditId,
  AuditOutcome,
  AuditRecord,
  Authorization,
  Client,
  ClientId,
  connectionSubject,
  ConnectionName,
  ConnectionRef,
  describeAuthorization,
  DriftEntry,
  DriftKind,
  Grant,
  GrantDecision,
  GrantId,
  IntegrationSlug,
  OwnerTier,
  PendingApproval,
  SubjectId,
  TenantId,
  ToolName,
  ToolSnapshot
} from "./domain.ts"

export {
  generateApiKey,
  hashApiKey,
  newApprovalId,
  newAuditId,
  newClientId,
  newGrantId
} from "./keys.ts"
export type { IssuedApiKey } from "./keys.ts"

export { createGatewayStore } from "./store.ts"
export type {
  CreateApprovalInput,
  CreateClientInput,
  CreateGrantInput,
  GatewayStore,
  RecordAuditInput
} from "./store.ts"

export { authorizeInvocation, authorizeMutation } from "./authorize.ts"

// Re-exported so consumers compose Executor through the gateway rather than
// reaching for the host package directly. `wfkit-executor` is an internal
// dependency of the gateway from here on.
export {
  createExecutorHost,
  createExecutorServices
} from "@mokronos/wfkit-executor"
export type {
  ExecutorHost,
  ExecutorServices
} from "@mokronos/wfkit-executor"
