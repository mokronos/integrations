import { mkdirSync } from "node:fs"
import path from "node:path"
import { NodeRuntime } from "@effect/platform-node"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Exit, Layer, ManagedRuntime, Schema } from "effect"
import { ClusterWorkflowEngine, SingleRunner } from "effect/unstable/cluster"
import { SqlClient } from "effect/unstable/sql"
import { DurableDeferred, WorkflowEngine } from "effect/unstable/workflow"
import type { DefinedWorkflow } from "./core.ts"
import type { SecretResolver } from "./secrets.ts"
import {
  emitWorkflowEvent
} from "./events.ts"
import type { WorkflowEventSink } from "./events.ts"
import {
  currentExecutionResources,
  registerExecutionResources,
  removeExecutionResources
} from "./execution-resources.ts"
import type { IntegrationInvoker } from "./integration.ts"
import { createConcurrencyLimiter } from "./concurrency.ts"
import type { ConcurrencyLimiter } from "./concurrency.ts"

export interface ExecuteWorkflowOptions {
  readonly onEvent?: WorkflowEventSink
  readonly engineDatabasePath?: string
}

export interface WorkflowRuntimeOptions {
  readonly backend: "memory" | "sqlite"
  readonly databasePath?: string
  /** Resolves SecretRef inputs to their values at step execution time.
   *  Only the reference string is ever persisted. */
  readonly secrets?: SecretResolver
  /** Concrete adapter used by provider-neutral integration steps. */
  readonly integrations?: IntegrationInvoker
  readonly sqliteBusyTimeoutMs?: number
  /** How often the engine polls storage for due timers and undelivered
   *  messages. Durable timers (signal timeouts, long sleeps) can fire up to
   *  one interval late. Defaults to 250ms. */
  readonly timerPollIntervalMs?: number
}

export interface WorkflowRuntime {
  readonly backend: "memory" | "sqlite"
  readonly databasePath?: string
  readonly secrets?: SecretResolver
  readonly integrations?: IntegrationInvoker
  readonly concurrency: ConcurrencyLimiter
  register(workflows: ReadonlyArray<any>): void
  getWorkflow(name: string): DefinedWorkflow | undefined
  listWorkflows(name?: string): ReadonlyArray<DefinedWorkflow>
  execute(options: {
    readonly workflow: DefinedWorkflow
    readonly payload: unknown
    readonly executionId: string
    readonly onEvent?: WorkflowEventSink
  }): Promise<unknown>
  deliverSignal(options: {
    readonly workflow: DefinedWorkflow
    readonly executionId: string
    readonly deferredName: string
    readonly payload: unknown
    readonly onEvent?: WorkflowEventSink
  }): Promise<void>
  interrupt(options: {
    readonly workflow: DefinedWorkflow
    readonly executionId: string
  }): Promise<void>
  /** Wake a suspended execution so it replays to its suspension point.
   *  No-op unless the run is recorded as suspended. */
  resume(options: {
    readonly workflow: DefinedWorkflow
    readonly executionId: string
  }): Promise<void>
  /** Releases the engine and its SQLite resources. A disposed runtime cannot be reused. */
  dispose(): Promise<void>
}

export class WorkflowConflictError extends Error {
  readonly _tag = "WorkflowConflictError"

  constructor(options: { readonly name: string }) {
    super(`Workflow ${options.name} is already registered with different source`)
    this.name = "WorkflowConflictError"
  }
}

const defaultEngineDatabasePath = () => path.join(process.cwd(), ".wf", "engine.sqlite")

// All durable-execution plumbing lives here so authored workflows never touch
// the cluster engine, the runner, or the backing store.
export const makeEngineLayer = (options: {
  readonly databasePath?: string
  readonly sqliteBusyTimeoutMs?: number
  readonly timerPollIntervalMs?: number
} = {}) => {
  const databasePath = path.resolve(options.databasePath ?? defaultEngineDatabasePath())
  const sqliteBusyTimeoutMs = Math.max(0, Math.trunc(options.sqliteBusyTimeoutMs ?? 5000))
  // The cluster default is 10 seconds, which delays every durable timer
  // (signal timeout, long sleep) by up to that long on a single-node engine.
  const timerPollIntervalMs = Math.max(10, Math.trunc(options.timerPollIntervalMs ?? 250))
  const sqliteLayer = Layer.unwrap(Effect.sync(() => {
    mkdirSync(path.dirname(databasePath), { recursive: true })
    return SqliteClient.layer({ filename: databasePath })
  }))
  const configuredSqliteLayer = Layer.effectDiscard(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql.unsafe(`PRAGMA busy_timeout = ${sqliteBusyTimeoutMs}`)
  })).pipe(Layer.provideMerge(sqliteLayer))

  return ClusterWorkflowEngine.layer.pipe(
    Layer.provideMerge(SingleRunner.layer({
      shardingConfig: { entityMessagePollInterval: timerPollIntervalMs }
    })),
    Layer.provide(configuredSqliteLayer)
  )
}

export const createWorkflowRuntime = (options: WorkflowRuntimeOptions): WorkflowRuntime => {
  const workflows = new Map<string, DefinedWorkflow>()
  const concurrency = createConcurrencyLimiter()
  const registeredExecutionIds = new Set<string>()
  const databasePath = options.databasePath

  const registerResources = (
    executionId: string,
    onEvent?: WorkflowEventSink
  ): void => {
    registerExecutionResources(executionId, {
      ...(onEvent === undefined ? {} : { events: onEvent }),
      ...(options.secrets === undefined ? {} : { secrets: options.secrets }),
      ...(options.integrations === undefined ? {} : { integrations: options.integrations }),
      concurrency
    })
    registeredExecutionIds.add(executionId)
  }

  const removeResources = (executionId: string): void => {
    removeExecutionResources(executionId)
    registeredExecutionIds.delete(executionId)
  }

  const env = () => {
    const workflowLayers = Array.from(workflows.values()).map((workflow) => workflow.layer)
    const base =
      options.backend === "sqlite"
        ? makeEngineLayer({
            ...(databasePath === undefined ? {} : { databasePath }),
            ...(options.sqliteBusyTimeoutMs === undefined ? {} : { sqliteBusyTimeoutMs: options.sqliteBusyTimeoutMs }),
            ...(options.timerPollIntervalMs === undefined ? {} : { timerPollIntervalMs: options.timerPollIntervalMs })
          })
        : WorkflowEngine.layerMemory
    return workflowLayers.reduce((layer, workflowLayer) => Layer.provideMerge(workflowLayer, layer), base)
  }

  // Reuse one engine for each immutable workflow registry snapshot. Old
  // snapshots stay alive until runtime disposal so registering a workflow
  // cannot tear resources out from under an active execution.
  const managedBySignature = new Map<
    string,
    ManagedRuntime.ManagedRuntime<any, unknown>
  >()
  let disposed = false

  const getManagedRuntime = () => {
    if (disposed) {
      throw new Error("Workflow runtime has been disposed")
    }
    const signature = Array.from(workflows.keys()).sort().join(",")
    const existing = managedBySignature.get(signature)
    if (existing !== undefined) return existing
    const created = ManagedRuntime.make(env())
    managedBySignature.set(signature, created)
    return created
  }

  const runEffect = <A>(effect: Effect.Effect<A, unknown, any>, onEvent?: WorkflowEventSink) =>
    getManagedRuntime().runPromise(
      effect.pipe(
        Effect.provideService(currentExecutionResources, {
          ...(onEvent === undefined ? {} : { events: onEvent }),
          ...(options.secrets === undefined ? {} : { secrets: options.secrets }),
          ...(options.integrations === undefined ? {} : { integrations: options.integrations }),
          concurrency
        })
      ) as Effect.Effect<A, unknown, never>
    )

  return {
    backend: options.backend,
    ...(databasePath === undefined ? {} : { databasePath }),
    ...(options.secrets === undefined ? {} : { secrets: options.secrets }),
    ...(options.integrations === undefined ? {} : { integrations: options.integrations }),
    concurrency,

    register(registered) {
      for (const workflow of registered) {
        const existing = workflows.get(workflow.name)
        if (existing !== undefined && existing.sourceHash !== workflow.sourceHash) {
          throw new WorkflowConflictError({ name: workflow.name })
        }
        workflows.set(workflow.name, workflow)
      }
    },

    getWorkflow(name) {
      return workflows.get(name)
    },

    listWorkflows(name) {
      return Array.from(workflows.values())
        .filter((workflow) => name === undefined || workflow.name === name)
        .sort((left, right) => left.name.localeCompare(right.name))
    },

    execute({ workflow, payload, executionId, onEvent }) {
      const workflowName = String(workflow.workflow.name ?? workflow.name)
      registerResources(executionId, onEvent)
      const effect = Effect.gen(function* () {
        const engine = yield* WorkflowEngine.WorkflowEngine
        yield* emitWorkflowEvent({ type: "workflow.started", workflowName, payload })
        const result = yield* engine.execute(workflow.workflow, {
          executionId,
          payload: { value: payload }
        }).pipe(
          Effect.tap((result: unknown) =>
            emitWorkflowEvent({ type: "workflow.completed", workflowName, result })
          ),
          Effect.tapError((error: unknown) =>
            emitWorkflowEvent({ type: "workflow.failed", workflowName, error })
          )
        )
        return result
      })
      return runEffect(effect, onEvent).finally(() => {
        removeResources(executionId)
      })
    },

    deliverSignal({ workflow, executionId, deferredName, payload, onEvent }) {
      // The resumed replay may execute steps in THIS process, so all execution
      // resources are registered together before the wake-up.
      registerResources(executionId, onEvent)
      const effect = Effect.gen(function* () {
        const engine = yield* WorkflowEngine.WorkflowEngine
        const deferred = DurableDeferred.make(deferredName, { success: Schema.Unknown })
        yield* engine.deferredDone(deferred, {
          workflowName: workflow.workflow.name,
          executionId,
          deferredName,
          exit: Exit.succeed(payload)
        })
        // deferredDone only resumes a run whose Suspended reply is already
        // persisted. A delivery racing the suspension write would otherwise
        // sit unnoticed until another wake-up, so nudge resume a few times
        // (resume is a no-op unless the run is recorded as suspended).
        for (let attempt = 0; attempt < 5; attempt++) {
          yield* Effect.sleep("100 millis")
          yield* engine.resume(workflow.workflow, executionId)
        }
      })
      // The resumed replay may run inside THIS call's engine environment, so
      // it needs the same event sink as the original execute to record
      // history (compensations, cancellation, signal receipt).
      return runEffect(effect, onEvent)
    },

    interrupt({ workflow, executionId }) {
      const effect = Effect.gen(function* () {
        const engine = yield* WorkflowEngine.WorkflowEngine
        yield* engine.interrupt(workflow.workflow, executionId)
      })
      return runEffect(effect)
    },

    resume({ workflow, executionId }) {
      const effect = Effect.gen(function* () {
        const engine = yield* WorkflowEngine.WorkflowEngine
        yield* engine.resume(workflow.workflow, executionId)
      })
      return runEffect(effect)
    },

    async dispose() {
      if (disposed) {
        return
      }
      disposed = true
      for (const executionId of registeredExecutionIds) {
        removeExecutionResources(executionId)
      }
      registeredExecutionIds.clear()
      const active = Array.from(managedBySignature.values())
      managedBySignature.clear()
      await Promise.all(active.map((runtime) => runtime.dispose()))
    }
  }
}

export const makeWorkflowEffect = (
  wf: DefinedWorkflow,
  payload: unknown,
  options: ExecuteWorkflowOptions = {}
) => {
  const env = wf.layer.pipe(
    Layer.provideMerge(makeEngineLayer(
      options.engineDatabasePath === undefined ? {} : { databasePath: options.engineDatabasePath }
    ))
  )
  const workflowName = String(wf.workflow.name ?? wf.name ?? "Workflow")
  const execution = Effect.gen(function* () {
    yield* emitWorkflowEvent({ type: "workflow.started", workflowName, payload })
    const result = yield* wf.workflow.execute({ value: payload }).pipe(
      Effect.tap((result: unknown) =>
        emitWorkflowEvent({ type: "workflow.completed", workflowName, result })
      ),
      Effect.tapError((error: unknown) =>
        emitWorkflowEvent({ type: "workflow.failed", workflowName, error })
      )
    )
    return result
  })

  return execution.pipe(
    Effect.provide(env),
    Effect.provideService(currentExecutionResources, {
      ...(options.onEvent === undefined ? {} : { events: options.onEvent })
    })
  )
}

export const executeWorkflow = (
  wf: DefinedWorkflow,
  payload: unknown,
  options: ExecuteWorkflowOptions = {}
) =>
  Effect.runPromise(
    makeWorkflowEffect(wf, payload, options) as Effect.Effect<unknown, unknown, never>
  )

// Execute a workflow to completion as a standalone program.
export const run = (wf: DefinedWorkflow, payload: unknown) => {
  return (makeWorkflowEffect(wf, payload) as Effect.Effect<unknown, unknown, never>).pipe(
    NodeRuntime.runMain
  )
}
