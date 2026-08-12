import { createExecutorAuth } from "./auth.ts"
import { createExecutorCatalog } from "./catalog.ts"
import { createExecutorConnections } from "./connections.ts"
import { createIntegrationDiscovery } from "./discovery.ts"
import type { ExecutorRunner } from "./host.ts"
import { createExecutorIntegrationInvoker } from "./invoker.ts"
import { resolveIntegrationSource } from "./integration-resolution.ts"
import { createIntegrationOverview } from "./overview.ts"
import { createIntegrationProvisioning } from "./provisioning.ts"
import { createExecutorTools } from "./tools.ts"
import { createIntegrationValidation } from "./validation.ts"

/** All Executor-backed capabilities sharing one explicitly owned host. */
export const createExecutorServices = (runner: ExecutorRunner) => {
  const catalog = createExecutorCatalog(runner)
  const connections = createExecutorConnections(runner)
  const auth = createExecutorAuth(runner)
  const tools = createExecutorTools(runner)
  const discovery = createIntegrationDiscovery({ catalog })
  return {
    catalog,
    connections,
    auth,
    tools,
    discovery,
    provisioning: createIntegrationProvisioning({ discovery, catalog, connections, tools }),
    validateIntegrationNode: createIntegrationValidation({ tools }),
    listIntegrationOverviews: createIntegrationOverview({ catalog, connections, tools }),
    resolveIntegration: (source: Parameters<typeof resolveIntegrationSource>[0]) =>
      resolveIntegrationSource(source, tools),
    integrationInvoker: createExecutorIntegrationInvoker(tools)
  }
}

export type ExecutorServices = ReturnType<typeof createExecutorServices>
