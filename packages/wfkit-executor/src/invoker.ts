import type { IntegrationInvoker } from "@mokronos/wfkit"
import { ExecutorToolAddress } from "./schemas.ts"
import { executeExecutorTool } from "./tools.ts"

/** The concrete Executor adapter for provider-neutral workflow integration
 * steps. Supply this at the application composition root. */
export const executorIntegrationInvoker: IntegrationInvoker = {
  invoke: async (address, input) =>
    await executeExecutorTool(ExecutorToolAddress.make(address), input)
}
