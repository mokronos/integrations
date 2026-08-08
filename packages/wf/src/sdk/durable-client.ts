import type { DefinedWorkflow } from "../core.ts"
import { Cancelled, cancellationDeferredName } from "../core.ts"
import type { WorkflowEvent } from "../events.ts"
import {
  ExecutionId
} from "../schemas.ts"
import { statusAfterEvent } from "../run-lifecycle.ts"
import type { WorkflowRuntime } from "../runtime.ts"
import { decodeSignal } from "../signal.ts"
import { parseJsonText } from "./json.ts"
import {
  observeExecution,
  optionalActor,
  optionalCursor,
  optionalFinishedAt,
  pendingSignalsFromHistory
} from "./client-lifecycle.ts"
import { decodePersistedJsonSchema } from "./json-schema-validation.ts"
import {
  decodeStoredValue,
  durableExecutionRecord
} from "./durable-client-model.ts"
import type { DurableExecutionRow } from "./durable-client-model.ts"
import { createDurableClientStore } from "./durable-client-store.ts"
import type {
  WorkflowClient,
  WorkflowResult
} from "./client-model.ts"

const executionId = () => crypto.randomUUID()
export const createDurableWorkflowClient = (runtime: WorkflowRuntime): WorkflowClient => {
  const databasePath = runtime.databasePath
  if (databasePath === undefined) {
    throw new Error("SQLite workflow client requires runtime.databasePath")
  }
  const store = createDurableClientStore(databasePath)
  const runPromises = new Map<string, Promise<WorkflowResult>>()
  let closing = false

  const workflowFor = (row: DurableExecutionRow): DefinedWorkflow => {
    const workflow = runtime.getWorkflow(row.workflow_name)
    if (workflow === undefined) {
      throw new Error(`Workflow ${row.workflow_name} is not registered in this runtime`)
    }
    return workflow
  }

  const workflowForStart = (workflow: DefinedWorkflow): DefinedWorkflow => {
    runtime.register([workflow])
    return workflow
  }

  const makeEventSink = (executionId: string) => async (event: WorkflowEvent) => {
    if (!store.appendHistory(executionId, event)) {
      // Replay re-emission: the status transition already happened when the
      // event fired for real, so don't let the replay flap it.
      return
    }
    const status = statusAfterEvent(event)
    if (status !== undefined) {
      store.updateStatus(executionId, status)
    }
  }

  const runToTerminal = async (row: DurableExecutionRow): Promise<WorkflowResult> => {
    if (row.status === "completed") {
      return { type: "completed", value: parseJsonText(row.result_json) }
    }
    if (row.status === "failed") {
      return { type: "failed", error: parseJsonText(row.error_json) }
    }

    const existing = runPromises.get(row.id)
    if (existing !== undefined) {
      return existing
    }

    const promise: Promise<WorkflowResult> = (async (): Promise<WorkflowResult> => {
      const workflow = workflowFor(row)
      try {
        const value = await runtime.execute({
          workflow,
          payload: decodeStoredValue(row.payload_json),
          executionId: row.id,
          onEvent: makeEventSink(row.id)
        })
        store.complete(row.id, value)
        return { type: "completed", value }
      } catch (error) {
        // Releasing a process-local engine while a workflow is durably parked
        // must not turn that resource shutdown into a persisted failure.
        if (closing) {
          return { type: "failed", error }
        }
        store.fail(row.id, error)
        return { type: "failed", error }
      }
    })()
    runPromises.set(row.id, promise)
    try {
      return await promise
    } finally {
      if (runPromises.get(row.id) === promise) {
        runPromises.delete(row.id)
      }
    }
  }

  return {
    async start(workflow, payload, opts = {}) {
      const selectedWorkflow = workflowForStart(workflow)
      if (opts.idempotencyKey !== undefined) {
        const existing = store.findIdempotent(selectedWorkflow.name, opts.idempotencyKey)
        if (existing !== undefined) {
          return { executionId: existing }
        }
      }

      const id = executionId()
      const inserted = store.insert({
        id,
        workflowName: selectedWorkflow.name,
        payload,
        ...(opts.artifactId === undefined ? {} : { artifactId: opts.artifactId }),
        ...(opts.idempotencyKey === undefined ? {} : { idempotencyKey: opts.idempotencyKey }),
        ...(opts.actor === undefined ? {} : { actor: opts.actor }),
        ...(opts.sourceHash === undefined ? {} : { sourceHash: opts.sourceHash })
      })
      if (!inserted) {
        const winner = opts.idempotencyKey === undefined
          ? undefined
          : store.findIdempotent(selectedWorkflow.name, opts.idempotencyKey)
        if (winner === undefined) {
          throw new Error(`Failed to insert workflow execution ${id}`)
        }
        return { executionId: winner }
      }
      store.appendHistory(id, {
        type: "execution.started",
        executionId: ExecutionId.make(id),
        workflowName: selectedWorkflow.name,
        payload,
        ...optionalActor(opts.actor)
      })

      void runToTerminal(store.get(id))
      return { executionId: id }
    },

    async signal(executionId, name, payload, opts = {}) {
      const row = store.get(executionId)
      const workflow = workflowFor(row)
      const waiting = pendingSignalsFromHistory(store.history(executionId))
        .filter((signal) => signal.name === name)
        .at(-1)
      if (waiting === undefined) {
        throw new Error(`Execution ${executionId} is not waiting for signal ${name}`)
      }
      // Validate before completing the durable deferred: a bad value persisted
      // there would otherwise fail the run during replay. The history schema is
      // durable, unlike the runtime's process-local schema registry.
      const schema = runtime.signals.getSchema(executionId, name)
      if (schema !== undefined) {
        decodeSignal(schema, payload)
      } else if (waiting.payloadSchema !== undefined) {
        decodePersistedJsonSchema(waiting.payloadSchema, payload)
      }
      // Ensure this runtime has loaded the suspended execution before waking
      // it so replay uses this runtime's secrets and integration adapters.
      await runtime.resume({ workflow, executionId })
      await runtime.deliverSignal({
        workflow,
        executionId,
        deferredName: `signal:${waiting.activityName}`,
        payload,
        onEvent: makeEventSink(executionId)
      })
      store.appendHistory(executionId, {
        type: "signal.delivered",
        executionId: ExecutionId.make(executionId),
        name,
        payload,
        ...optionalActor(opts.actor)
      })
      store.updateStatus(executionId, "running")
    },

    result(executionId) {
      return runToTerminal(store.get(executionId))
    },

    async status(executionId) {
      return store.get(executionId).status
    },

    async execution(executionId) {
      return durableExecutionRecord(store.get(executionId))
    },

    async executions() {
      return store.all().map(durableExecutionRecord)
    },

    async list(workflow, opts = {}) {
      const rows = store.forWorkflow(workflow.name)
        .filter((row) => opts.status === undefined || row.status === opts.status)
      const start = opts.cursor === undefined ? 0 : Number.parseInt(opts.cursor, 10)
      const limit = opts.limit ?? rows.length
      const page = rows.slice(start, start + limit)
      const next = start + limit < rows.length ? String(start + limit) : undefined
      return {
        executions: page.map((row) => ({
          executionId: row.id,
          workflowName: row.workflow_name,
          status: row.status,
          startedAt: row.started_at,
          ...optionalFinishedAt(row.finished_at ?? undefined)
        })),
        ...optionalCursor(next)
      }
    },

    async history(executionId) {
      return store.history(executionId)
    },

    async pendingSignals(executionId) {
      return pendingSignalsFromHistory(store.history(executionId))
    },

    async cancel(executionId, opts = {}) {
      const row = store.get(executionId)
      const workflow = workflowFor(row)
      const compensate = opts.compensate ?? true
      store.appendHistory(executionId, {
        type: "execution.cancelled",
        executionId: ExecutionId.make(executionId),
        compensate,
        ...optionalActor(opts.actor)
      })
      if (compensate) {
        // Complete the reserved cancellation deferred: the execution wakes at
        // its current suspension point, fails with Cancelled, and unwinds the
        // compensation stack before being recorded as failed.
        store.updateStatus(executionId, "compensating")
        await runtime.deliverSignal({
          workflow,
          executionId,
          deferredName: cancellationDeferredName,
          payload: { compensate: true, ...(opts.actor === undefined ? {} : { actor: opts.actor }) },
          onEvent: makeEventSink(executionId)
        })
        store.fail(executionId, new Cancelled({ compensate: true }))
      } else {
        // Hard kill: engine-level interrupt, no unwind.
        await runtime.interrupt({ workflow, executionId })
        store.fail(executionId, new Cancelled({ compensate: false }))
      }
    },

    observe(executionId, options = {}) {
      return observeExecution({
        status: async (id) => store.get(id).status,
        result: (id) => runToTerminal(store.get(id)),
        pendingSignals: async (id) => pendingSignalsFromHistory(store.history(id))
      }, executionId, options.signal)
    },

    async dispose() {
      closing = true
      await runtime.dispose()
      await Promise.allSettled(runPromises.values())
      store.close()
    }
  }
}
