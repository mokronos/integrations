import type { IntegrationInvoker } from "@mokronos/wfkit"
import { ExecutorToolAddress } from "./schemas.ts"
import { executeExecutorTool } from "./tools.ts"
import type { ExecutorTools } from "./tools.ts"

export const createExecutorIntegrationInvoker = (
  tools: Pick<ExecutorTools, "execute">
): IntegrationInvoker => ({
  invoke: async (address, input) =>
    await tools.execute(ExecutorToolAddress.make(address), input)
})

/** The concrete Executor adapter for provider-neutral workflow integration
 * steps. Supply this at the application composition root. */
export const executorIntegrationInvoker = createExecutorIntegrationInvoker({
  execute: executeExecutorTool
})
