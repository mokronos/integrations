import { createExecutorCatalog } from "./catalog.ts"
import { createExecutorConnections } from "./connections.ts"
import { createIntegrationDiscovery } from "./discovery.ts"
import type { ExecutorRunner } from "./host.ts"
import { createExecutorIntegrationInvoker } from "./invoker.ts"
import { createExecutorTools } from "./tools.ts"

/** All Executor-backed capabilities sharing one explicitly owned host. */
export const createExecutorServices = (runner: ExecutorRunner) => {
  const catalog = createExecutorCatalog(runner)
  const connections = createExecutorConnections(runner)
  const tools = createExecutorTools(runner)
  return {
    catalog,
    connections,
    tools,
    discovery: createIntegrationDiscovery({ catalog, connections, tools }),
    integrationInvoker: createExecutorIntegrationInvoker(tools)
  }
}

export type ExecutorServices = ReturnType<typeof createExecutorServices>
