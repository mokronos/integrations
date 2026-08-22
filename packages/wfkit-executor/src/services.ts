import { createExecutorAuth } from "./auth.ts"
import { createExecutorCatalog } from "./catalog.ts"
import { createExecutorConnections } from "./connections.ts"
import { createIntegrationDiscovery } from "./discovery.ts"
import type { ExecutorHostStorage, ExecutorRunner } from "./host.ts"
import { createIntegrationOverview } from "./overview.ts"
import { createIntegrationProvisioning } from "./provisioning.ts"
import { createExecutorTools } from "./tools.ts"
import { createIntegrationValidation } from "./validation.ts"
import { Context, Effect, Layer } from "effect"
import { ExecutorHostService } from "./host.ts"

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
    listIntegrationOverviews: createIntegrationOverview({ catalog, connections, tools })
  }
}

export type ExecutorServices = ReturnType<typeof createExecutorServices>

/** The complete Executor capability derived from one scoped host. */
export class ExecutorServicesService extends Context.Service<
  ExecutorServicesService,
  ExecutorServices
>()("@mokronos/wfkit-executor/ExecutorServices") {
  static readonly layerNoDeps: Layer.Layer<
    ExecutorServicesService,
    never,
    ExecutorHostService
  > = Layer.effect(
    ExecutorServicesService,
    Effect.gen(function* () {
      const host = yield* ExecutorHostService
      return createExecutorServices(host)
    })
  )

  static readonly layer = (
    directory: string,
    storage?: ExecutorHostStorage
  ): Layer.Layer<ExecutorServicesService> =>
    this.layerNoDeps.pipe(Layer.provide(ExecutorHostService.layer(directory, storage)))

  /** Exposes the host as well for composition roots that publish lifecycle
   * diagnostics in addition to the focused services. */
  static readonly layerWithHost = (
    directory: string,
    storage?: ExecutorHostStorage
  ): Layer.Layer<ExecutorServicesService | ExecutorHostService> =>
    this.layerNoDeps.pipe(Layer.provideMerge(ExecutorHostService.layer(directory, storage)))
}
