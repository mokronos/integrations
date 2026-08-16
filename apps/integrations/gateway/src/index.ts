export { gatewayDatabasePath, integrationsHome } from "./paths.ts"
export { createGateway } from "./host.ts"
export type { Gateway } from "./host.ts"

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
