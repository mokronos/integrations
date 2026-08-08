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
  createExecutorConnections,
  createExecutorConnection,
  createExecutorOAuthClient,
  ensureExecutorConnection,
  listExecutorConnections,
  probeExecutorOAuth,
  registerExecutorOAuthClient,
  removeExecutorConnection,
  startExecutorOAuth
} from "./connections.ts"
export type { ExecutorConnections } from "./connections.ts"
export {
  closeExecutor,
  createExecutorHost,
  executorStorageDirectory,
  getExecutor,
  setExecutorStorageDirectory
} from "./host.ts"
export type { ExecutorHost, ExecutorRunner } from "./host.ts"
export {
  createExecutorTools,
  executeExecutorTool,
  listExecutorTools,
  normalizeExecutorToolOutputSchema,
  normalizeExecutorToolResult
} from "./tools.ts"
export type { ExecutorTools } from "./tools.ts"
