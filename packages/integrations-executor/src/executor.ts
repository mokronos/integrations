/** Compatibility barrel for the original Executor-facing API. New code should
 * import through the package entrypoint; implementation concerns live in the
 * focused modules below. */
export {
  addExecutorMcp,
  addExecutorOpenApi,
  createExecutorCatalog,
  detectExecutorIntegration,
  findExecutorIntegration,
  listExecutorIntegrations,
  previewExecutorOpenApi,
  probeExecutorMcp
} from "./catalog.ts"
export type { ExecutorCatalog } from "./catalog.ts"
export {
  completeExecutorOAuth,
  createExecutorAuth,
  createExecutorOAuthClient,
  probeExecutorOAuth,
  registerExecutorOAuthClient,
  startExecutorOAuth
} from "./auth.ts"
export type { ExecutorAuth } from "./auth.ts"
export {
  createExecutorConnections,
  createExecutorConnection,
  ensureExecutorConnection,
  listExecutorConnections,
  removeExecutorConnection
} from "./connections.ts"
export type { ExecutorConnections } from "./connections.ts"
export {
  closeExecutor,
  executorStorageDirectory,
  getExecutor,
  setExecutorStorageDirectory
} from "./default-host.ts"
export {
  createExecutorHost,
  ExecutorHostClosedError,
  ExecutorHostService,
} from "./host.ts"
export type { ExecutorHost, ExecutorHostStorage, ExecutorRunner } from "./host.ts"
export {
  createExecutorTools,
  describeExecutorTool,
  executeExecutorTool,
  listExecutorTools,
  listExecutorToolSummaries,
  normalizeExecutorToolOutputSchema,
  normalizeExecutorToolResult
} from "./tools.ts"
export type {
  ExecutorToolFilter,
  ExecutorTools,
  ExecutorToolTarget
} from "./tools.ts"
