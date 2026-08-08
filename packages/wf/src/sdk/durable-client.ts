import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import path from "node:path"
import { Schema } from "effect"
import type { DefinedWorkflow } from "../core.ts"
import { Cancelled, cancellationDeferredName } from "../core.ts"
import type { WorkflowEvent } from "../events.ts"
import {
  ExecutionId,
  WorkflowHistoryEvent as WorkflowHistoryEventSchema,
  WorkflowRunStatus as WorkflowRunStatusSchema
} from "../schemas.ts"
import type { WorkflowHistoryEvent, WorkflowHistoryRecord } from "../schemas.ts"
import { statusAfterEvent } from "../run-lifecycle.ts"
import type { WorkflowRuntime } from "../runtime.ts"
import { decodeSignal } from "../signal.ts"
import { parseJsonText, toJsonText } from "./json.ts"
import { replayDedupeKey } from "../replay.ts"
import {
  nowIso,
  observeExecution,
  optionalActor,
  optionalCursor,
  optionalFinishedAt,
  pendingSignalsFromHistory
} from "./client-lifecycle.ts"
import { migrateClientDatabase } from "./client-database.ts"
import { decodePersistedJsonSchema } from "./json-schema-validation.ts"
import type {
  WorkflowClient,
  WorkflowExecutionRecord,
  WorkflowExecutionStatus,
  WorkflowResult
} from "./client-model.ts"

const executionId = () => crypto.randomUUID()
const StoredValueJson = Schema.fromJsonString(Schema.Struct({ value: Schema.Unknown }))
const encodeStoredValue = (value: unknown): string =>
  Schema.encodeSync(StoredValueJson)({ value })
const decodeStoredValue = (json: string): unknown =>
  Schema.decodeUnknownSync(StoredValueJson)(json).value

const DurableExecutionRow = Schema.Struct({
  id: Schema.String,
  artifact_id: Schema.NullOr(Schema.String),
  workflow_name: Schema.String,
  status: WorkflowRunStatusSchema,
  payload_json: Schema.String,
  idempotency_key: Schema.NullOr(Schema.String),
  actor: Schema.NullOr(Schema.String),
  source_hash: Schema.NullOr(Schema.String),
  result_json: Schema.NullOr(Schema.String),
  error_json: Schema.NullOr(Schema.String),
  started_at: Schema.String,
  finished_at: Schema.NullOr(Schema.String)
})
type DurableExecutionRow = typeof DurableExecutionRow.Type

const DurableHistoryRow = Schema.Struct({
  sequence: Schema.Number,
  event_json: Schema.String,
  created_at: Schema.String
})
type DurableHistoryRow = typeof DurableHistoryRow.Type

const StoredHistoryEventJson = Schema.fromJsonString(WorkflowHistoryEventSchema)
const decodeExecutionRow = Schema.decodeUnknownSync(DurableExecutionRow)
const decodeHistoryRow = Schema.decodeUnknownSync(DurableHistoryRow)

export const createDurableWorkflowClient = (runtime: WorkflowRuntime): WorkflowClient => {
  const databasePath = runtime.databasePath
  if (databasePath === undefined) {
    throw new Error("SQLite workflow client requires runtime.databasePath")
  }
  mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true })
  const db = new Database(databasePath, { create: true, readwrite: true })
  migrateClientDatabase(db)
  const runPromises = new Map<string, Promise<WorkflowResult>>()
  let closing = false

  // Returns false when the event is a replay re-emission that is already
  // recorded (the engine replays workflow code whenever a suspended run
  // resumes, possibly in another process).
  const appendHistory = (executionId: string, event: WorkflowHistoryEvent): boolean => {
    const dedupeKey = replayDedupeKey(event) ?? null
    if (dedupeKey !== null) {
      const existing = db.query<{ id: number }, [string, string]>(`
        SELECT id
        FROM wf_client_history
        WHERE execution_id = ?
          AND dedupe_key = ?
      `).get(executionId, dedupeKey)
      if (existing !== null) {
        return false
      }
    }
    const sequence = db.query<{ sequence: number }, [string]>(`
      SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
      FROM wf_client_history
      WHERE execution_id = ?
    `).get(executionId)?.sequence ?? 1
    db.query<Record<string, never>, [string, number, string, string, string | null]>(`
      INSERT INTO wf_client_history (execution_id, sequence, event_json, created_at, dedupe_key)
      VALUES (?, ?, ?, ?, ?)
    `).run(executionId, sequence, toJsonText(event), nowIso(), dedupeKey)
    return true
  }

  const updateStatus = (executionId: string, status: WorkflowExecutionStatus) => {
    db.query<Record<string, never>, [WorkflowExecutionStatus, string]>(`
      UPDATE wf_client_executions
      SET status = ?
      WHERE id = ?
    `).run(status, executionId)
  }

  const getRow = (executionId: string): DurableExecutionRow => {
    const row = db.query<DurableExecutionRow, [string]>(`
      SELECT *
      FROM wf_client_executions
      WHERE id = ?
    `).get(executionId)
    if (row === null) {
      throw new Error(`Unknown workflow execution: ${executionId}`)
    }
    return decodeExecutionRow(row)
  }

  const executionRecord = (row: DurableExecutionRow): WorkflowExecutionRecord => ({
    executionId: row.id,
    ...(row.artifact_id === null ? {} : { artifactId: row.artifact_id }),
    workflowName: row.workflow_name,
    status: row.status,
    payload: decodeStoredValue(row.payload_json),
    startedAt: row.started_at,
    ...optionalFinishedAt(row.finished_at ?? undefined),
    ...(row.source_hash === null ? {} : { sourceHash: row.source_hash })
  })

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
    if (!appendHistory(executionId, event)) {
      // Replay re-emission: the status transition already happened when the
      // event fired for real, so don't let the replay flap it.
      return
    }
    const status = statusAfterEvent(event)
    if (status !== undefined) {
      updateStatus(executionId, status)
    }
  }

  const readHistory = (executionId: string): ReadonlyArray<WorkflowHistoryRecord> => {
    getRow(executionId)
    return db.query<DurableHistoryRow, [string]>(`
      SELECT sequence, event_json, created_at
      FROM wf_client_history
      WHERE execution_id = ?
      ORDER BY sequence
    `).all(executionId).map((row) => decodeHistoryRow(row)).map((row) => ({
      sequence: row.sequence,
      createdAt: row.created_at,
      event: Schema.decodeUnknownSync(StoredHistoryEventJson)(row.event_json)
    }))
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
        db.query<Record<string, never>, [string, string, string]>(`
          UPDATE wf_client_executions
          SET status = 'completed',
            result_json = ?,
            finished_at = ?
          WHERE id = ?
        `).run(toJsonText(value), nowIso(), row.id)
        return { type: "completed", value }
      } catch (error) {
        // Releasing a process-local engine while a workflow is durably parked
        // must not turn that resource shutdown into a persisted failure.
        if (closing) {
          return { type: "failed", error }
        }
        db.query<Record<string, never>, [string, string, string]>(`
          UPDATE wf_client_executions
          SET status = 'failed',
            error_json = ?,
            finished_at = ?
          WHERE id = ?
        `).run(toJsonText(error), nowIso(), row.id)
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
        const existing = db.query<{ id: string }, [string, string]>(`
          SELECT id
          FROM wf_client_executions
          WHERE workflow_name = ?
            AND idempotency_key = ?
        `).get(selectedWorkflow.name, opts.idempotencyKey)
        if (existing !== null) {
          return { executionId: existing.id }
        }
      }

      const id = executionId()
      db.query<
        Record<string, never>,
        [string, string | null, string, string, string | null, string | null, string | null, string]
      >(`
        INSERT INTO wf_client_executions (
          id,
          artifact_id,
          workflow_name,
          status,
          payload_json,
          idempotency_key,
          actor,
          source_hash,
          started_at
        )
        VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?)
      `).run(
        id,
        opts.artifactId ?? null,
        selectedWorkflow.name,
        encodeStoredValue(payload),
        opts.idempotencyKey ?? null,
        opts.actor ?? null,
        opts.sourceHash ?? null,
        nowIso()
      )
      appendHistory(id, {
        type: "execution.started",
        executionId: ExecutionId.make(id),
        workflowName: selectedWorkflow.name,
        payload,
        ...optionalActor(opts.actor)
      })

      void runToTerminal(getRow(id))
      return { executionId: id }
    },

    async signal(executionId, name, payload, opts = {}) {
      const row = getRow(executionId)
      const workflow = workflowFor(row)
      const waiting = pendingSignalsFromHistory(readHistory(executionId))
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
      appendHistory(executionId, {
        type: "signal.delivered",
        executionId: ExecutionId.make(executionId),
        name,
        payload,
        ...optionalActor(opts.actor)
      })
      updateStatus(executionId, "running")
    },

    result(executionId) {
      return runToTerminal(getRow(executionId))
    },

    async status(executionId) {
      return getRow(executionId).status
    },

    async execution(executionId) {
      return executionRecord(getRow(executionId))
    },

    async executions() {
      return db.query<DurableExecutionRow, []>(`
        SELECT *
        FROM wf_client_executions
        ORDER BY started_at DESC
      `).all().map((row) => decodeExecutionRow(row)).map(executionRecord)
    },

    async list(workflow, opts = {}) {
      const rows = db.query<DurableExecutionRow, [string]>(`
        SELECT *
        FROM wf_client_executions
        WHERE workflow_name = ?
        ORDER BY started_at
      `).all(workflow.name).map((row) => decodeExecutionRow(row))
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
      return readHistory(executionId)
    },

    async pendingSignals(executionId) {
      return pendingSignalsFromHistory(readHistory(executionId))
    },

    async cancel(executionId, opts = {}) {
      const row = getRow(executionId)
      const workflow = workflowFor(row)
      const compensate = opts.compensate ?? true
      appendHistory(executionId, {
        type: "execution.cancelled",
        executionId: ExecutionId.make(executionId),
        compensate,
        ...optionalActor(opts.actor)
      })
      if (compensate) {
        // Complete the reserved cancellation deferred: the execution wakes at
        // its current suspension point, fails with Cancelled, and unwinds the
        // compensation stack before being recorded as failed.
        updateStatus(executionId, "compensating")
        await runtime.deliverSignal({
          workflow,
          executionId,
          deferredName: cancellationDeferredName,
          payload: { compensate: true, ...(opts.actor === undefined ? {} : { actor: opts.actor }) },
          onEvent: makeEventSink(executionId)
        })
        db.query<Record<string, never>, [string, string, string]>(`
          UPDATE wf_client_executions
          SET status = 'failed',
            error_json = ?,
            finished_at = ?
          WHERE id = ?
        `).run(toJsonText(new Cancelled({ compensate: true })), nowIso(), executionId)
      } else {
        // Hard kill: engine-level interrupt, no unwind.
        updateStatus(executionId, "failed")
        await runtime.interrupt({ workflow, executionId })
      }
    },

    observe(executionId, options = {}) {
      return observeExecution({
        status: async (id) => getRow(id).status,
        result: (id) => runToTerminal(getRow(id)),
        pendingSignals: async (id) => pendingSignalsFromHistory(readHistory(id))
      }, executionId, options.signal)
    },

    async dispose() {
      closing = true
      await runtime.dispose()
      await Promise.allSettled(runPromises.values())
      db.close()
    }
  }
}
