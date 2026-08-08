import { Effect } from "effect"
import {
  currentExecutionResources,
  getExecutionResources
} from "./execution-resources.ts"
import { WorkflowEvent as WorkflowEventSchema, isWorkflowEvent } from "./schemas.ts"

export { isWorkflowEvent }
export const WorkflowEvent = WorkflowEventSchema
export type WorkflowEvent = typeof WorkflowEventSchema.Type

export type WorkflowEventSink = (event: WorkflowEvent) => void | Promise<void>

export const emitWorkflowEvent = (event: WorkflowEvent): Effect.Effect<void> =>
  Effect.gen(function* () {
    const fiberResources = yield* currentExecutionResources
    const executionId = (event as { readonly executionId?: string }).executionId
    const sink = executionId === undefined
      ? fiberResources.events
      : getExecutionResources(executionId, fiberResources).events
    if (sink === undefined) {
      return
    }
    yield* Effect.promise(() => Promise.resolve(sink(event)))
  })
