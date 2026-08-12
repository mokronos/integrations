import type { IntegrationInvoker } from "@mokronos/wfkit"
import {
  describeIntegrationResolution,
  resolveIntegrationSource
} from "./integration-resolution.ts"
import { ExecutorToolAddress } from "./schemas.ts"
import { createExecutorTools } from "./tools.ts"
import { runExecutor } from "./default-host.ts"
import type { ExecutorTools } from "./tools.ts"

/** Resolves the portable reference against live connections on every invocation,
 * then executes the address it resolved to.
 *
 * Resolution is deliberately not cached: a step can be reached minutes after the
 * workflow started, and re-resolving picks up a connection that was added in the
 * meantime. Replay never comes through here — a completed step returns its
 * recorded result — so this stays a live lookup without affecting determinism. */
export const createExecutorIntegrationInvoker = (
  tools: Pick<ExecutorTools, "summaries" | "execute">
): IntegrationInvoker => ({
  invoke: async (source, input) => {
    if ("address" in source) {
      return await tools.execute(ExecutorToolAddress.make(source.address), input)
    }
    const resolution = await resolveIntegrationSource(source, tools)
    if (resolution.status !== "resolved") {
      throw new Error(describeIntegrationResolution(source, resolution))
    }
    return await tools.execute(resolution.address, input)
  }
})

/** The concrete Executor adapter for provider-neutral workflow integration
 * steps. Supply this at the application composition root. */
export const executorIntegrationInvoker = createExecutorIntegrationInvoker(
  createExecutorTools({ run: runExecutor })
)
