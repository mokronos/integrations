import {
  createExecutorHost,
  createExecutorServices
} from "@mokronos/wfkit-executor"
import type { ExecutorHost, ExecutorServices } from "@mokronos/wfkit-executor"
import { integrationsHome } from "./paths.ts"

export interface Gateway {
  readonly directory: string
  readonly host: ExecutorHost
  readonly executor: ExecutorServices
  close(): Promise<void>
}

/** Composes one gateway over an explicit storage directory. Construction of the
 * underlying Executor stays lazy, and nothing mutates global storage state. */
export const createGateway = (
  options: { readonly directory?: string } = {}
): Gateway => {
  const host = createExecutorHost(options.directory ?? integrationsHome())
  return {
    directory: host.directory,
    host,
    executor: createExecutorServices(host),
    close: () => host.close()
  }
}
