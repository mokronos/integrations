import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import path from "node:path"
import { Schema } from "effect"
import type { DefinedWorkflow } from "../core.ts"
import { Cancelled, cancellationDeferredName } from "../core.ts"
import type { WorkflowEvent } from "../events.ts"
import { ExecutionId, WorkflowHistoryEvent as WorkflowHistoryEventSchema } from "../schemas.ts"
import type { JsonSchema, WorkflowHistoryEvent, WorkflowHistoryRecord, WorkflowRunStatus } from "../schemas.ts"
import { statusAfterEvent } from "../run-lifecycle.ts"
import { createWorkflowRuntime } from "../runtime.ts"
import type { WorkflowRuntime } from "../runtime.ts"
import { decodeSignal, getSignalSchema } from "../signal.ts"
import type { WorkflowArtifact, WorkflowRunRecord } from "./artifact.ts"
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
import { createMemoryWorkflowClient } from "./memory-client.ts"

export type WorkflowExecutionStatus = WorkflowRunStatus

export interface WorkflowExecutionHandle {
  readonly executionId: string
}

export type WorkflowResult =
  | { readonly type: "completed"; readonly value: unknown }
  | { readonly type: "failed"; readonly error: unknown }

export type WorkflowObservation =
  | { readonly type: "terminal"; readonly result: WorkflowResult }
  | { readonly type: "signal-suspended"; readonly pendingSignals: ReadonlyArray<PendingSignal> }

export type { WorkflowHistoryEvent }

export type { WorkflowHistoryRecord }

export interface WorkflowExecutionRecord {
  readonly executionId: string
  readonly artifactId?: string
  readonly workflowName: string
  readonly status: WorkflowExecutionStatus
  readonly payload: unknown
  readonly startedAt: string
  readonly finishedAt?: string
  /**
   * The snapshot of the workflow source this execution started against. Resuming
   * it replays that source, not whatever the catalog file says now.
   */
  readonly sourceHash?: string
}

export interface PendingSignal {
  readonly name: string
  readonly invocation: number
  readonly activityName: string
  readonly timeout?: unknown
  /** JSON Schema of the payload the wait expects. */
  readonly payloadSchema?: JsonSchema
}

export interface WorkflowListResult {
  readonly executions: ReadonlyArray<{
    readonly executionId: string
    readonly workflowName: string
    readonly status: WorkflowExecutionStatus
    readonly startedAt: string
    readonly finishedAt?: string
  }>
  readonly cursor?: string
}

export interface WorkflowClient {
  start<I, O, E>(
    workflow: DefinedWorkflow<I, O, E>,
    payload: I,
    opts?: {
      readonly idempotencyKey?: string
      readonly actor?: string
      readonly artifactId?: string
      /** Snapshot to pin this execution to, so later edits cannot change its replay. */
      readonly sourceHash?: string
    }
  ): Promise<WorkflowExecutionHandle>
  signal(
    executionId: string,
    name: string,
    payload: unknown,
    opts?: { readonly actor?: string }
  ): Promise<void>
  result(executionId: string): Promise<WorkflowResult>
  status(executionId: string): Promise<WorkflowExecutionStatus>
  execution(executionId: string): Promise<WorkflowExecutionRecord>
  executions(): Promise<ReadonlyArray<WorkflowExecutionRecord>>
  list<I, O, E>(
    workflow: DefinedWorkflow<I, O, E>,
    opts?: {
      readonly status?: WorkflowExecutionStatus
      readonly limit?: number
      readonly cursor?: string
    }
  ): Promise<WorkflowListResult>
  history(executionId: string): Promise<ReadonlyArray<WorkflowHistoryRecord>>
  pendingSignals(executionId: string): Promise<ReadonlyArray<PendingSignal>>
  cancel(
    executionId: string,
    opts?: { readonly compensate?: boolean; readonly actor?: string }
  ): Promise<void>
  /** Waits for a terminal result or signal suspension without exposing polling. */
  observe(executionId: string, options?: { readonly signal?: AbortSignal }): Promise<WorkflowObservation>
  dispose(): Promise<void>
}

/** Catalog artifacts annotate executions; lifecycle state itself stays engine-owned. */
export const lifecycleRunRecords = async (
  client: WorkflowClient,
  artifacts: ReadonlyArray<WorkflowArtifact>
): Promise<ReadonlyArray<WorkflowRunRecord>> =>
  (await client.executions()).map((execution) => {
    // A run names the catalog entry it started from. When that entry is gone the
    // run still stands on its own, labelled by the workflow name in its history.
    const artifact = artifacts.find((candidate) => candidate.id === execution.artifactId)
    return {
      id: ExecutionId.make(execution.executionId),
      workflowId: artifact?.id ?? execution.workflowName,
      status: execution.status,
      input: execution.payload,
      startedAt: execution.startedAt,
      ...(execution.finishedAt === undefined ? {} : { finishedAt: execution.finishedAt })
    }
  })

export { Cancelled } from "../core.ts"

const executionId = () => crypto.randomUUID()
const StoredValueJson = Schema.fromJsonString(Schema.Struct({ value: Schema.Unknown }))
const encodeStoredValue = (value: unknown): string =>
  Schema.encodeSync(StoredValueJson)({ value })
const decodeStoredValue = (json: string): unknown =>
  Schema.decodeUnknownSync(StoredValueJson)(json).value
export { pendingSignalsFromHistory } from "./client-lifecycle.ts"

export const createWorkflowClient = (
  runtime: WorkflowRuntime = createWorkflowRuntime({ backend: "memory" })
): WorkflowClient =>
  runtime.backend === "sqlite" ? createDurableWorkflowClient(runtime) : createMemoryWorkflowClient(runtime)

interface DurableExecutionRow {
  readonly id: string
  readonly artifact_id: string | null
  readonly workflow_name: string
  readonly status: WorkflowExecutionStatus
  readonly payload_json: string
  readonly idempotency_key: string | null
  readonly actor: string | null
  readonly source_hash: string | null
  readonly result_json: string | null
  readonly error_json: string | null
  readonly started_at: string
  readonly finished_at: string | null
}

interface DurableHistoryRow {
  readonly sequence: number
  readonly event_json: string
  readonly created_at: string
}

const migrateClientDb = (db: Database) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS wf_client_executions (
       id TEXT PRIMARY KEY,
      artifact_id TEXT,
      workflow_name TEXT NOT NULL,
      status TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      idempotency_key TEXT,
      actor TEXT,
      source_hash TEXT,
      result_json TEXT,
      error_json TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS wf_client_executions_idempotency_idx
      ON wf_client_executions(workflow_name, idempotency_key)
      WHERE idempotency_key IS NOT NULL;

    CREATE TABLE IF NOT EXISTS wf_client_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      execution_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      event_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      dedupe_key TEXT,
      UNIQUE(execution_id, sequence)
    );
  `)

  const columns = db.query<{ name: string }, []>("PRAGMA table_info(wf_client_history)").all()
  if (!columns.some((column) => column.name === "dedupe_key")) {
    db.exec("ALTER TABLE wf_client_history ADD COLUMN dedupe_key TEXT")
  }
  const executionColumns = db.query<{ name: string }, []>("PRAGMA table_info(wf_client_executions)").all()
  if (!executionColumns.some((column) => column.name === "artifact_id")) {
    db.exec("ALTER TABLE wf_client_executions ADD COLUMN artifact_id TEXT")
  }
  if (!executionColumns.some((column) => column.name === "source_hash")) {
    db.exec("ALTER TABLE wf_client_executions ADD COLUMN source_hash TEXT")
  }
  // Workflow versioning was removed from the engine, but a database written
  // before that still carries a NOT NULL workflow_version that nothing fills —
  // which fails every insert until the column goes. The idempotency index is
  // rebuilt from the current definition because the old one keyed on the
  // version, which would block the drop and no longer describes uniqueness.
  if (executionColumns.some((column) => column.name === "workflow_version")) {
    db.exec(`
      DROP INDEX IF EXISTS wf_client_executions_idempotency_idx;
      ALTER TABLE wf_client_executions DROP COLUMN workflow_version;
      CREATE UNIQUE INDEX IF NOT EXISTS wf_client_executions_idempotency_idx
        ON wf_client_executions(workflow_name, idempotency_key)
        WHERE idempotency_key IS NOT NULL;
    `)
  }
  // wf_client_workflows pinned one source hash per workflow *name* for all time,
  // which made editing a workflow that had ever run a hard error. Executions pin
  // their own snapshot now (source_hash above). Preserve every existing pin
  // before the legacy per-name table is dropped.
  const legacyWorkflowTable = db.query<{ readonly name: string }, []>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'wf_client_workflows'"
  ).get()
  if (legacyWorkflowTable !== null) {
    db.exec(`
      UPDATE wf_client_executions
      SET source_hash = (
        SELECT source_hash
        FROM wf_client_workflows
        WHERE wf_client_workflows.workflow_name = wf_client_executions.workflow_name
      )
      WHERE source_hash IS NULL
        AND EXISTS (
          SELECT 1
          FROM wf_client_workflows
          WHERE wf_client_workflows.workflow_name = wf_client_executions.workflow_name
        );
    `)
  }
  db.exec("DROP TABLE IF EXISTS wf_client_workflows")
  db.exec(`
    CREATE INDEX IF NOT EXISTS wf_client_history_dedupe_idx
      ON wf_client_history(execution_id, dedupe_key)
      WHERE dedupe_key IS NOT NULL
  `)
}

const createDurableWorkflowClient = (runtime: WorkflowRuntime): WorkflowClient => {
  const databasePath = runtime.databasePath
  if (databasePath === undefined) {
    throw new Error("SQLite workflow client requires runtime.databasePath")
  }
  mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true })
  const db = new Database(databasePath, { create: true, readwrite: true })
  migrateClientDb(db)
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
    db.query<unknown, [string, number, string, string, string | null]>(`
      INSERT INTO wf_client_history (execution_id, sequence, event_json, created_at, dedupe_key)
      VALUES (?, ?, ?, ?, ?)
    `).run(executionId, sequence, toJsonText(event), nowIso(), dedupeKey)
    return true
  }

  const updateStatus = (executionId: string, status: WorkflowExecutionStatus) => {
    db.query<unknown, [WorkflowExecutionStatus, string]>(`
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
    return row
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
    `).all(executionId).map((row) => ({
      sequence: row.sequence,
      createdAt: row.created_at,
      event: Schema.decodeUnknownSync(WorkflowHistoryEventSchema)(JSON.parse(row.event_json))
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
        db.query<unknown, [string, string, string]>(`
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
        db.query<unknown, [string, string, string]>(`
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
        unknown,
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
      // Validate the payload against the schema of the wait the run is parked
      // at BEFORE completing the durable deferred — a bad value persisted into
      // the deferred would otherwise fail the run at replay. In a fresh
      // process the schema registry is empty until the run replays, so nudge
      // a resume and wait for the workflow to park again.
      let schema = getSignalSchema(executionId, name)
      if (schema === undefined) {
        await runtime.resume({ workflow, executionId })
        for (let attempt = 0; attempt < 50 && schema === undefined; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 50))
          schema = getSignalSchema(executionId, name)
        }
      }
      if (schema !== undefined) {
        decodeSignal(schema, payload)
      }
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
      `).all().map(executionRecord)
    },

    async list(workflow, opts = {}) {
      const rows = db.query<DurableExecutionRow, [string]>(`
        SELECT *
        FROM wf_client_executions
        WHERE workflow_name = ?
        ORDER BY started_at
      `).all(workflow.name)
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
        db.query<unknown, [string, string, string]>(`
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
