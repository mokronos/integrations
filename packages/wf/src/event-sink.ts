import type { WorkflowEvent } from "./schemas.ts"

export type WorkflowEventSink = (event: WorkflowEvent) => void | Promise<void>
