import { Context } from "effect"
import type { SecretResolver } from "./secrets.ts"
import type { WorkflowEventSink } from "./event-sink.ts"
import type { IntegrationInvoker } from "./integration-invoker.ts"
import type { ConcurrencyLimiter } from "./concurrency.ts"
import type { SignalTransport } from "./signal.ts"

/** Replaceable dependencies owned by one workflow execution. Keeping them in
 * one record gives the runtime one registration and cleanup lifecycle. */
export interface ExecutionResources {
  readonly events?: WorkflowEventSink
  readonly secrets?: SecretResolver
  readonly integrations?: IntegrationInvoker
  readonly concurrency?: ConcurrencyLimiter
  readonly signals?: SignalTransport
}

export interface ExecutionResourceRegistryService {
  readonly register: (executionId: string, resources: ExecutionResources) => void
  readonly remove: (executionId: string) => void
  readonly get: (executionId: string) => ExecutionResources
  readonly clear: () => void
}

export class ExecutionResourceRegistry extends Context.Service<
  ExecutionResourceRegistry,
  ExecutionResourceRegistryService
>()("@mokronos/wfkit/ExecutionResourceRegistry") {}

export const makeExecutionResourceRegistry = (
  defaults: ExecutionResources = {}
): ExecutionResourceRegistryService => {
  const resourcesByExecution = new Map<string, ExecutionResources>()
  return {
    register: (executionId, resources) => {
      resourcesByExecution.set(executionId, resources)
    },
    remove: (executionId) => {
      resourcesByExecution.delete(executionId)
    },
    get: (executionId) => ({
      ...defaults,
      ...resourcesByExecution.get(executionId)
    }),
    clear: () => {
      resourcesByExecution.clear()
    }
  }
}
