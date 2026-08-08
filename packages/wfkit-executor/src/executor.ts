/** Compatibility barrel for the original Executor-facing API. New code should
 * import through the package entrypoint; implementation concerns live in the
 * focused modules below. */
export {
  addExecutorMcp,
  addExecutorOpenApi,
  detectExecutorIntegration,
  findExecutorIntegration,
  listExecutorIntegrations,
  previewExecutorOpenApi,
  probeExecutorMcp
} from "./catalog.ts"
export {
  completeExecutorOAuth,
  createExecutorConnection,
  createExecutorOAuthClient,
  ensureExecutorConnection,
  listExecutorConnections,
  probeExecutorOAuth,
  registerExecutorOAuthClient,
  removeExecutorConnection,
  startExecutorOAuth
} from "./connections.ts"
export {
  closeExecutor,
  executorStorageDirectory,
  getExecutor,
  setExecutorStorageDirectory
} from "./host.ts"
export {
  executeExecutorTool,
  listExecutorTools,
  normalizeExecutorToolOutputSchema,
  normalizeExecutorToolResult
} from "./tools.ts"
