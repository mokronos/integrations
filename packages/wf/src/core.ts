import { createHash } from "node:crypto"
import { Activity, DurableClock, DurableDeferred, Workflow, WorkflowEngine } from "effect/unstable/workflow"
import { Cause, Effect, Exit, Option, Schema } from "effect"
import type * as Duration from "effect/Duration"
import { emitWorkflowEvent } from "./events.ts"
import type { IntegrationInvoker } from "./integration.ts"
import {
  ExecutionResourceRegistry,
  makeExecutionResourceRegistry
} from "./execution-resources.ts"
import type { WorkflowEvent } from "./schemas.ts"
import { ExecutionId, jsonSchemaOf } from "./schemas.ts"
import {
  defaultSignalTransport,
  SignalDeliveryError
} from "./signal.ts"
import type { SignalTransport } from "./signal.ts"
import { defaultConcurrencyLimiter } from "./concurrency.ts"
import type { ConcurrencyLimiter, StepConcurrencyPolicy } from "./concurrency.ts"
import {
  Cancelled,
  CancellationRequest,
  cancellationDeferredName,
  skipsCompensation
} from "./cancellation.ts"
export { Cancelled, cancellationDeferredName } from "./cancellation.ts"
import {
  createInMemoryDeterminismState,
  NonDeterminismError,
  OrchestrationCall,
  orchestrationCallsEqual,
  orchestrationValueKey,
  verifyOrchestrationCall
} from "./determinism.ts"
import type { InMemoryDeterminismState } from "./determinism.ts"
export {
  createInMemoryDeterminismState,
  NonDeterminismError,
  OrchestrationCall,
  OrchestrationKind
} from "./determinism.ts"
export type { InMemoryDeterminismState } from "./determinism.ts"
import {
  resolveSecretReferences
} from "./secrets.ts"
import type {
  SecretResolutionContext,
  SecretResolver
} from "./secrets.ts"
export {
  envSecretResolver,
  isSecretRef,
  secret,
  SecretRef,
  SecretResolutionContext
} from "./secrets.ts"
export type { SecretResolver } from "./secrets.ts"

type AnySchema<A = any> = Schema.Codec<A, any, never, never>
type DynamicService = Schema.Schema.Type<Schema.Top>
const WorkflowPayloadSchema = Schema.Struct({ value: Schema.Unknown })

const TerminalFailureTypeId: unique symbol = Symbol.for("wf/TerminalFailure")

export interface TerminalFailure<E> {
  readonly [TerminalFailureTypeId]: typeof TerminalFailureTypeId
  readonly error: E
}

export interface StepContext<E> {
  fail(error: E): TerminalFailure<E>
  resolveSecret(name: string, context?: SecretResolutionContext): Promise<string>
  invokeIntegration(
    address: string,
    input: typeof Schema.Json.Type
  ): Promise<typeof Schema.Json.Type>
  readonly attempt: number
  readonly executionId: string
}

export interface StepRetryPolicy {
  readonly attempts: number
  readonly backoff: "exponential" | "none"
}

export type StepConcurrency<I> = StepConcurrencyPolicy<I>

export interface Step<I, O, E = never> {
  readonly name: string
  readonly input: AnySchema<I>
  readonly output: AnySchema<O>
  readonly errors: AnySchema<E>
  readonly execute: (input: I, step: StepContext<E>) => Promise<O | TerminalFailure<E>>
  readonly compensate?: (result: O, input: I, reason: unknown) => unknown | Promise<unknown>
  readonly retry?: StepRetryPolicy
  readonly concurrency?: StepConcurrency<I>
}

export interface DefineStepConfig<I, O, E> {
  readonly name: string
  readonly input: AnySchema<I>
  readonly output: AnySchema<O>
  readonly errors?: AnySchema<E>
  readonly execute: (input: I, step: StepContext<E>) => Promise<O | TerminalFailure<E>>
  readonly compensate?: (result: O, input: I, reason: unknown) => unknown | Promise<unknown>
  readonly retry?: StepRetryPolicy
  readonly concurrency?: StepConcurrency<I>
}

export const defineStep = <
  const Input extends AnySchema,
  const Output extends AnySchema,
  const Errors extends AnySchema = typeof Schema.Never
>(config: {
  readonly name: string
  readonly input: Input
  readonly output: Output
  readonly errors?: Errors
  readonly execute: (
    input: Schema.Schema.Type<Input>,
    step: StepContext<Schema.Schema.Type<Errors>>
  ) => Promise<Schema.Schema.Type<Output> | TerminalFailure<Schema.Schema.Type<Errors>>>
  readonly compensate?: (
    result: Schema.Schema.Type<Output>,
    input: Schema.Schema.Type<Input>,
    reason: unknown
  ) => unknown | Promise<unknown>
  readonly retry?: StepRetryPolicy
  readonly concurrency?: StepConcurrency<Schema.Schema.Type<Input>>
}): Step<Schema.Schema.Type<Input>, Schema.Schema.Type<Output>, Schema.Schema.Type<Errors>> => ({
  ...config,
  errors: config.errors ?? Schema.Never
})

export type WorkflowValue<A, E = never> = Effect.Effect<A, E, any>

type WorkflowValueSuccess<EffectValue> =
  EffectValue extends WorkflowValue<infer A, any> ? A : never

type WorkflowValueError<EffectValue> =
  EffectValue extends WorkflowValue<any, infer E> ? E : never

type WorkflowAllSuccess<Effects extends ReadonlyArray<WorkflowValue<any, any>>> = {
  -readonly [K in keyof Effects]: WorkflowValueSuccess<Effects[K]>
}

type WorkflowAllError<Effects extends ReadonlyArray<WorkflowValue<any, any>>> =
  WorkflowValueError<Effects[number]>

export type SignalOutcome<T> =
  | { readonly type: "signal"; readonly value: T }
  | { readonly type: "timeout" }

export interface WorkflowContext<WErrors> {
  readonly executionId: string
  run<I, O, E>(step: Step<I, O, E>, input: I): WorkflowValue<O, E | NonDeterminismError>
  sleep(duration: Duration.Input, name?: string): WorkflowValue<void, NonDeterminismError>
  waitForSignal<T>(
    name: string,
    schema: AnySchema<T>,
    opts?: { readonly timeout?: Duration.Input }
  ): WorkflowValue<SignalOutcome<T>, NonDeterminismError | SignalDeliveryError>
  now(): WorkflowValue<Date, NonDeterminismError>
  random(): WorkflowValue<number, NonDeterminismError>
  code<T>(name: string, options: {
    readonly reason?: string
    readonly run: () => T | Promise<T>
  }): WorkflowValue<T, NonDeterminismError>
  all<const Effects extends ReadonlyArray<WorkflowValue<any, any>>>(
    effects: Effects,
    options?: { readonly name?: string; readonly concurrency?: number | "unbounded" }
  ): WorkflowValue<WorkflowAllSuccess<Effects>, WorkflowAllError<Effects> | NonDeterminismError>
  fail(error: WErrors): WorkflowValue<never, WErrors>
  effect<A, E>(effect: Effect.Effect<A, E, never>): WorkflowValue<A, E>
}

export interface DefineWorkflowConfig<I, O, WErrors = never> {
  readonly name: string
  readonly input: AnySchema<I>
  readonly output: AnySchema<O>
  readonly errors?: AnySchema<WErrors>
  readonly run: (input: I, ctx: WorkflowContext<WErrors>) => Generator<any, O, any>
}

export const DefinedWorkflowTypeId = Symbol.for("wf/DefinedWorkflow")

export interface DefinedWorkflow<I = any, O = any, WErrors = any> {
  readonly [DefinedWorkflowTypeId]: typeof DefinedWorkflowTypeId
  readonly name: string
  readonly sourceHash: string
  readonly input: AnySchema<I>
  readonly output: AnySchema<O>
  readonly errors: AnySchema<WErrors>
  readonly workflow: any
  readonly layer: any
  readonly execute: (payload: I) => Effect.Effect<O, WErrors | unknown, DynamicService>
  readonly executeInMemory: (payload: I, options?: InMemoryExecutionOptions) => Promise<O>
}

export interface InMemoryExecutionOptions {
  readonly executionId?: string
  readonly determinism?: InMemoryDeterminismState
  readonly onEvent?: (event: WorkflowEvent) => void | Promise<void>
  readonly stepExecutors?: ReadonlyMap<Step<any, any, any>, Step<any, any, any>["execute"]>
  readonly stepExecutor?: (options: {
    readonly step: Step<any, any, any>
    readonly input: unknown
    readonly invocation: number
    readonly activityName: string
    readonly context: StepContext<any>
  }) => unknown | Promise<unknown>
  readonly sleep?: (options: {
    readonly executionId: string
    readonly name: string
    readonly duration: Duration.Input
  }) => Promise<void>
  readonly signalTimeout?: (options: {
    readonly executionId: string
    readonly name: string
    readonly duration: Duration.Input
  }) => Promise<void>
  readonly signalValue?: (options: {
    readonly executionId: string
    readonly name: string
    readonly schema: AnySchema
  }) => unknown | Promise<unknown>
  /** Execution-scoped signal adapter. Defaults to the legacy singleton. */
  readonly signalTransport?: SignalTransport
  readonly secrets?: SecretResolver
  readonly integrations?: IntegrationInvoker
  readonly concurrency?: ConcurrencyLimiter
}

interface CompensationEntry {
  readonly stepName: string
  readonly invocation: number
  readonly result: unknown
  readonly input: unknown
  readonly compensate: (result: unknown, input: unknown, reason: unknown) => unknown | Promise<unknown>
}

type ActivityFailure =
  | { readonly _wfFailureType: "terminal"; readonly error: unknown }
  | { readonly _wfFailureType: "transient"; readonly error: unknown }

class AsyncFailure extends Error {
  readonly _tag = "AsyncFailure"
  readonly error: unknown

  constructor(error: unknown) {
    super(error instanceof Error ? error.message : "Async operation failed")
    this.name = "AsyncFailure"
    this.error = error
  }
}

const isTerminalFailure = <E>(value: unknown): value is TerminalFailure<E> =>
  typeof value === "object" &&
  value !== null &&
  TerminalFailureTypeId in value &&
  value[TerminalFailureTypeId] === TerminalFailureTypeId

const isActivityFailure = (value: unknown): value is ActivityFailure =>
  typeof value === "object" &&
  value !== null &&
  "_wfFailureType" in value &&
  (value._wfFailureType === "terminal" || value._wfFailureType === "transient")

const unwrapActivityFailure = (error: unknown): unknown =>
  isActivityFailure(error) ? error.error : error

const unwrapAsyncFailure = (error: unknown): unknown =>
  error instanceof AsyncFailure ? error.error : error

const makeStepContext = <E>(
  _errors: AnySchema<E>,
  executionId: string,
  attempt: number,
  resolver?: SecretResolver,
  integrations?: IntegrationInvoker
): StepContext<E> => ({
  attempt,
  executionId,
  fail: (error) => ({ [TerminalFailureTypeId]: TerminalFailureTypeId, error }),
  resolveSecret: (name, context) => {
    if (resolver === undefined) throw new Error(`No secret resolver configured for ${name}`)
    return Promise.resolve(resolver.resolve(name, context))
  },
  invokeIntegration: (address, input) => {
    if (integrations === undefined) {
      throw new Error(`No integration invoker configured for ${address}`)
    }
    return integrations.invoke(address, input)
  }
})

const nextInvocation = (counters: Map<string, number>, name: string): number => {
  const invocation = (counters.get(name) ?? 0) + 1
  counters.set(name, invocation)
  return invocation
}

const decodeSync = <A>(schema: AnySchema<A>, value: unknown): A =>
  Schema.decodeUnknownSync(schema)(value)

const encodeSync = <A>(schema: AnySchema<A>, value: A): unknown =>
  Schema.encodeSync(schema)(value)

// Durable race with a persisted winner. This deliberately does NOT use
// DurableDeferred.raceAll: its replay path runs `Effect.flatten(exit)` over
// the stored winner, which dies with "Not a valid effect" for plain (non-
// Effect) winner values. We store/unwrap the same way DurableDeferred.await
// does — a single `yield*` of the persisted exit.
const raceDurable = (
  name: string,
  effects: ReadonlyArray<Effect.Effect<any, any, any>>
): Effect.Effect<any, any, any> =>
  Effect.gen(function* () {
    const deferred = DurableDeferred.make(name, { success: Schema.Unknown })
    const engine = yield* WorkflowEngine.WorkflowEngine
    const exit = yield* Workflow.wrapActivityResult(
      engine.deferredResult(deferred),
      Option.isNone
    )
    if (Option.isSome(exit)) {
      return yield* exit.value as Exit.Exit<any, any>
    }
    return yield* DurableDeferred.into(Effect.raceAll(effects) as any, deferred as any)
  })

const transientAttempts = (retry: StepRetryPolicy | undefined): number =>
  Math.max(1, retry?.attempts ?? 1)

const retryDelayMillis = (retry: StepRetryPolicy | undefined, attempt: number): number =>
  retry?.backoff === "exponential" && attempt > 1
    ? 10 * 2 ** (attempt - 2)
    : 0

const makeCtx = <WErrors>(
  wf: any,
  executionId: ExecutionId,
  workflowErrors: AnySchema<WErrors>
): WorkflowContext<WErrors> => {
  const counters = new Map<string, number>()
  let journalPosition = 0
  let parallelDepth = 0

  const recordCall = (actual: OrchestrationCall): Effect.Effect<void, NonDeterminismError, any> => {
    const position = ++journalPosition
    const activityName = parallelDepth > 0
      ? `determinism:${actual.kind}:${actual.name}#${actual.counter}`
      : `determinism#${position}`
    return Activity.make({
      name: activityName,
      success: OrchestrationCall,
      execute: Effect.succeed(actual)
    }).pipe(
      Effect.flatMap((expected) =>
        orchestrationCallsEqual(expected, actual)
          ? Effect.void
          : Effect.fail(new NonDeterminismError({ expected, actual }))
      )
    )
  }

  const cancellationDeferred = DurableDeferred.make(cancellationDeferredName, {
    success: CancellationRequest
  })

  // A suspension point races its own durable operation against the reserved
  // cancellation deferred, so a cancel request wakes the execution and unwinds
  // it instead of leaving it parked forever.
  const cancellationBranch = DurableDeferred.await(cancellationDeferred).pipe(
    Effect.map((request) => ({
      type: "cancelled" as const,
      compensate: request.compensate,
      actor: request.actor
    }))
  )

  const failCancelled = (outcome: { compensate: boolean; actor?: string }) =>
    Effect.gen(function* () {
      yield* emitWorkflowEvent({
        type: "cancellation.received",
        executionId,
        compensate: outcome.compensate,
        ...(outcome.actor === undefined ? {} : { actor: outcome.actor })
      })
      // A plain failure exit: withCompensation finalizers run for compensate:
      // true. compensate: false never reaches here (the client interrupts the
      // engine directly), but failing is still the safe fallback.
      return yield* new Cancelled({ compensate: outcome.compensate })
    })

  return {
    executionId,

    run(step, rawInput) {
      const invocation = nextInvocation(counters, step.name)
      const activityName = `${step.name}#${invocation}`
      const call: OrchestrationCall = { kind: "step", name: step.name, counter: invocation }
      const input = decodeSync(step.input, rawInput)

      const execute = Effect.gen(function* () {
        const attempt = yield* Activity.CurrentAttempt
        const retryDelay = retryDelayMillis(step.retry, attempt)
        if (retryDelay > 0) {
          yield* Effect.sleep(`${retryDelay} millis`)
        }
        yield* emitWorkflowEvent({
          type: "step.started",
          executionId,
          stepName: step.name,
          invocation,
          activityName,
          attempt,
          input
        })

        const registry = yield* ExecutionResourceRegistry
        const resources = registry.get(executionId)
        const resolver = resources.secrets
        const integrations = resources.integrations
        const result = yield* Effect.tryPromise({
          try: async () => {
            const release = await (resources.concurrency ?? defaultConcurrencyLimiter)
              .acquire(step.name, step.concurrency, input)
            try {
              const executeInput = decodeSync(
                step.input,
                await resolveSecretReferences(input, resolver)
              )
              const value = await step.execute(
                executeInput,
                makeStepContext(step.errors, executionId, attempt, resolver, integrations)
              )
              if (isTerminalFailure(value)) {
                throw value
              }
              return decodeSync(step.output, value)
            } finally {
              release()
            }
          },
          catch: (error) => {
            if (isTerminalFailure(error)) {
              return {
                _wfFailureType: "terminal",
                error: decodeSync(step.errors, error.error)
              } satisfies ActivityFailure
            }
            return { _wfFailureType: "transient", error } satisfies ActivityFailure
          }
        })

        yield* emitWorkflowEvent({
          type: "step.completed",
          executionId,
          stepName: step.name,
          invocation,
          activityName,
          attempt,
          result
        })

        return result
      }).pipe(
        Effect.tapError((error) =>
          emitWorkflowEvent({
            type: "step.failed",
            executionId,
            stepName: step.name,
            invocation,
            activityName,
            error: unwrapActivityFailure(error)
          })
        )
      )

      let activity: Effect.Effect<unknown, unknown, any> = Activity.make({
        name: activityName,
        success: step.output,
        error: Schema.Unknown,
        execute
      })

      activity = activity.pipe(
        Activity.retry({
          times: transientAttempts(step.retry) - 1,
          while: (error: unknown) =>
            isActivityFailure(error) && error._wfFailureType === "transient"
        }),
        Effect.mapError(unwrapActivityFailure)
      )

      if (step.compensate !== undefined) {
        const compensate = step.compensate
        activity = activity.pipe(
          wf.withCompensation((value: unknown, cause: Cause.Cause<unknown>) =>
            Effect.gen(function* () {
              yield* emitWorkflowEvent({
                type: "compensation.started",
                executionId,
                stepName: step.name,
                invocation,
                activityName,
                result: value,
                input,
                reason: cause
              })
              const result = decodeSync(step.output, value)
              yield* Effect.tryPromise({
                try: () => Promise.resolve(compensate(result, input, cause)),
                catch: (error) => new AsyncFailure(error)
              }).pipe(
                Effect.tapError((error) =>
                  emitWorkflowEvent({
                    type: "compensation.failed",
                    executionId,
                    stepName: step.name,
                    invocation,
                    activityName,
                    error: unwrapAsyncFailure(error)
                  })
                ),
                Effect.orDie
              )
              yield* emitWorkflowEvent({
                type: "compensation.completed",
                executionId,
                stepName: step.name,
                invocation,
                activityName
              })
            })
          )
        )
      }

      return Effect.gen(function* () {
        yield* recordCall(call)
        return yield* activity
      }) as Effect.Effect<any, any, any>
    },

    all(effects, options) {
      const name = options?.name ?? "all"
      const invocation = nextInvocation(counters, name)
      const activityName = `${name}#${invocation}`
      const branches = effects.length
      const call: OrchestrationCall = { kind: "all", name, counter: invocation, branches }
      return Effect.gen(function* () {
        yield* recordCall(call)
        yield* emitWorkflowEvent({
          type: "all.started",
          executionId,
          name,
          invocation,
          activityName,
          branches
        })
        yield* Effect.sync(() => {
          parallelDepth++
        })
        const combined = Effect.all(effects, {
          concurrency: options?.concurrency ?? "unbounded"
        }) as Effect.Effect<any, any, any>
        return yield* combined.pipe(
            Effect.ensuring(Effect.sync(() => {
              parallelDepth--
            })),
            Effect.tap(() => emitWorkflowEvent({
              type: "all.completed",
              executionId,
              name,
              invocation,
              activityName,
              branches
            })),
            Effect.tapError((error) => emitWorkflowEvent({
              type: "all.failed",
              executionId,
              name,
              invocation,
              activityName,
              branches,
              error
            }))
          ) as Effect.Effect<any, any, any>
      }) as Effect.Effect<any, any, any>
    },

    sleep(duration, name) {
      const baseName = name ?? `sleep:${String(duration)}`
      const invocation = nextInvocation(counters, baseName)
      const sleepName = `${baseName}#${invocation}`
      const call: OrchestrationCall = { kind: "sleep", name: baseName, counter: invocation }
      return Effect.gen(function* () {
        yield* recordCall(call)
        yield* emitWorkflowEvent({
          type: "sleep.started",
          executionId,
          name: baseName,
          invocation,
          activityName: sleepName,
          duration
        })
        const outcome = (yield* raceDurable(`race:${sleepName}`, [
          // Sleeps under the engine's in-memory threshold (60s) run inside
          // an activity that holds the entity mailbox, so a cancellation
          // delivered mid-sleep is consumed at the NEXT suspension point,
          // not instantly — bounded by the threshold. Longer sleeps go
          // durable and wake immediately on cancellation.
          DurableClock.sleep({ name: sleepName, duration }).pipe(
            Effect.map(() => ({ type: "slept" as const }))
          ),
          cancellationBranch
        ])) as { type: "slept" } | { type: "cancelled"; compensate: boolean; actor?: string }
        if (outcome.type === "cancelled") {
          return yield* failCancelled(outcome)
        }
        yield* emitWorkflowEvent({
          type: "sleep.completed",
          executionId,
          name: baseName,
          invocation,
          activityName: sleepName,
          duration
        })
      }) as Effect.Effect<any, any, any>
    },

    waitForSignal(name, schema, opts) {
      const invocation = nextInvocation(counters, name)
      const waitName = `${name}#${invocation}`
      const call: OrchestrationCall = { kind: "signal", name, counter: invocation }
      const payloadSchema = jsonSchemaOf(schema)

      return Effect.gen(function* () {
        yield* recordCall(call)
        // Delivery-side validation needs the schema of the wait the run is
        // parked at; replay re-registers it in a fresh process.
        const registry = yield* ExecutionResourceRegistry
        const resources = registry.get(executionId)
        const signals = resources.signals ?? defaultSignalTransport
        signals.registerSchema(executionId, name, schema)
        yield* emitWorkflowEvent({
          type: "signal.waiting",
          executionId,
          name,
          invocation,
          activityName: waitName,
          timeout: opts?.timeout,
          ...(payloadSchema === undefined ? {} : { payloadSchema })
        })

        const deferredName = `signal:${waitName}`
        const deferred = DurableDeferred.make(deferredName, { success: schema })

        // The race winner is persisted, so the signal value crosses replay as
        // its encoded form and is re-decoded below.
        const signalBranch = DurableDeferred.await(deferred).pipe(
          Effect.map((value) => ({
            type: "signal" as const,
            encoded: encodeSync(schema, value)
          }))
        )
        const timeoutBranch = opts?.timeout === undefined
          ? []
          : [
              DurableClock.sleep({
                name: `signal-timeout:${waitName}`,
                duration: opts.timeout,
                inMemoryThreshold: "1 milli"
              }).pipe(Effect.map(() => ({ type: "timeout" as const })))
            ]

        const outcome = (yield* raceDurable(`race:${waitName}`, [
          signalBranch,
          ...timeoutBranch,
          cancellationBranch
        ])) as
          | { type: "signal"; encoded: unknown }
          | { type: "timeout" }
          | { type: "cancelled"; compensate: boolean; actor?: string }

        if (outcome.type === "cancelled") {
          return yield* failCancelled(outcome)
        }

        if (outcome.type === "timeout") {
          yield* emitWorkflowEvent({
            type: "signal.timeout",
            executionId,
            name,
            invocation,
            activityName: waitName,
            timeout: opts?.timeout
          })
          return { type: "timeout" } as const
        }

        const value = decodeSync(schema, outcome.encoded)
        yield* emitWorkflowEvent({
          type: "signal.received",
          executionId,
          name,
          invocation,
          activityName: waitName,
          payload: value
        })
        return { type: "signal", value } as const
      }) as Effect.Effect<any, any, any>
    },

    now() {
      const invocation = nextInvocation(counters, "now")
      const activityName = `now#${invocation}`
      const call: OrchestrationCall = { kind: "now", name: "now", counter: invocation }
      const activity = Activity.make({
        name: activityName,
        success: Schema.Date,
        execute: Effect.sync(() => new Date())
      })
      return Effect.gen(function* () {
        yield* recordCall(call)
        return yield* activity
      })
    },

    random() {
      const invocation = nextInvocation(counters, "random")
      const activityName = `random#${invocation}`
      const call: OrchestrationCall = { kind: "random", name: "random", counter: invocation }
      const activity = Activity.make({
        name: activityName,
        success: Schema.Number,
        execute: Effect.sync(() => Math.random())
      })
      return Effect.gen(function* () {
        yield* recordCall(call)
        return yield* activity
      })
    },

    code(name, options) {
      const invocation = nextInvocation(counters, name)
      const activityName = `${name}#${invocation}`
      const call: OrchestrationCall = { kind: "code", name, counter: invocation }
      const execute = Effect.gen(function* () {
        yield* emitWorkflowEvent({
          type: "code.started",
          executionId,
          name,
          invocation,
          activityName,
          ...(options.reason === undefined ? {} : { reason: options.reason })
        })
        const result = yield* Effect.tryPromise({
          try: async () => options.run(),
          catch: (error) => new AsyncFailure(error)
        })
        yield* emitWorkflowEvent({
          type: "code.completed",
          executionId,
          name,
          invocation,
          activityName,
          ...(options.reason === undefined ? {} : { reason: options.reason }),
          result
        })
        return result
      }).pipe(
        Effect.tapError((error) =>
          emitWorkflowEvent({
            type: "code.failed",
            executionId,
            name,
            invocation,
            activityName,
            ...(options.reason === undefined ? {} : { reason: options.reason }),
            error: unwrapAsyncFailure(error)
          })
        )
      )
      const activity = Activity.make({
        name: activityName,
        success: Schema.Unknown,
        error: Schema.Unknown,
        execute
      }).pipe(Effect.mapError(unwrapAsyncFailure))
      return Effect.gen(function* () {
        yield* recordCall(call)
        return yield* activity
      }) as Effect.Effect<any, any, any>
    },

    fail(error) {
      return Effect.fail(decodeSync(workflowErrors, error))
    },

    effect(effect) {
      return effect as Effect.Effect<any, any, any>
    }
  }
}

const makeInMemoryCtx = <WErrors>(
  executionId: ExecutionId,
  workflowErrors: AnySchema<WErrors>,
  compensations: CompensationEntry[],
  determinism: InMemoryDeterminismState,
  emit: (event: WorkflowEvent) => Promise<void>,
  options: Pick<
    InMemoryExecutionOptions,
    "stepExecutors" | "stepExecutor" | "sleep" | "signalTimeout" | "signalValue" | "signalTransport" | "secrets" | "integrations" | "concurrency"
  > = {}
): WorkflowContext<WErrors> => {
  const counters = new Map<string, number>()
  let journalPosition = 0
  let blockPosition = 0
  const branchCollectors: Array<OrchestrationCall[]> = []
  const signals = options.signalTransport ?? defaultSignalTransport

  const recordCall = async (actual: OrchestrationCall): Promise<void> => {
    const index = journalPosition++
    const expected = determinism.calls[index]
    if (expected === undefined) {
      determinism.calls.push(actual)
    } else {
      verifyOrchestrationCall(expected, actual)
    }
    branchCollectors[branchCollectors.length - 1]?.push(actual)
  }

  return {
    executionId,

    run(step, rawInput) {
      const invocation = nextInvocation(counters, step.name)
      const activityName = `${step.name}#${invocation}`
      const input = decodeSync(step.input, rawInput)
      return Effect.tryPromise({
        try: async () => {
          await recordCall({ kind: "step", name: step.name, counter: invocation })
          const attempts = transientAttempts(step.retry)
          let lastTransient: unknown

          for (let attempt = 1; attempt <= attempts; attempt++) {
            await emit({
              type: "step.started",
              executionId,
              stepName: step.name,
              invocation,
              activityName,
              attempt,
              input
            })

            try {
              const stepContext = makeStepContext(
                step.errors,
                executionId,
                attempt,
                options.secrets,
                options.integrations
              )
              const executeStep = options.stepExecutors?.get(step)
              const release = await (options.concurrency ?? defaultConcurrencyLimiter)
                .acquire(step.name, step.concurrency, input)
              try {
                const executeInput = decodeSync(
                  step.input,
                  await resolveSecretReferences(input, options.secrets)
                )
                const value = await (
                  options.stepExecutor?.({ step, input: executeInput, invocation, activityName, context: stepContext }) ??
                  executeStep?.(executeInput, stepContext as any) ??
                  step.execute(executeInput, stepContext)
                )
                if (isTerminalFailure(value)) {
                  const terminal = decodeSync(step.errors, value.error)
                  throw terminal
                }

                const result = decodeSync(step.output, value)
                encodeSync(step.output, result)
                await emit({
                  type: "step.completed",
                  executionId,
                  stepName: step.name,
                  invocation,
                  activityName,
                  attempt,
                  result
                })

                if (step.compensate !== undefined) {
                  const compensate = step.compensate
                  compensations.push({
                    stepName: step.name,
                    invocation,
                    result,
                    input,
                    compensate: (result, compensationInput, reason) => compensate(
                      decodeSync(step.output, result),
                      decodeSync(step.input, compensationInput),
                      reason
                    )
                  })
                }

                return result
              } finally {
                release()
              }
            } catch (error) {
              if (attempt === attempts || isDeclaredTerminal(step.errors, error)) {
                await emit({
                  type: "step.failed",
                  executionId,
                  stepName: step.name,
                  invocation,
                  activityName,
                  error
                })
                throw error
              }
              lastTransient = error
            }
          }

          throw lastTransient
        },
        catch: (error) => new AsyncFailure(error)
      }).pipe(Effect.mapError(unwrapAsyncFailure)) as Effect.Effect<any, any, any>
    },

    sleep(duration, name) {
      const baseName = name ?? `sleep:${String(duration)}`
      const invocation = nextInvocation(counters, baseName)
      const activityName = `${baseName}#${invocation}`
      return Effect.promise(async () => {
        await recordCall({ kind: "sleep", name: baseName, counter: invocation })
        await emit({
          type: "sleep.started",
          executionId,
          name: baseName,
          invocation,
          activityName,
          duration
        })
        await options.sleep?.({ executionId, name: activityName, duration })
        await emit({
          type: "sleep.completed",
          executionId,
          name: baseName,
          invocation,
          activityName,
          duration
        })
      })
    },

    waitForSignal(name, schema, opts) {
      const invocation = nextInvocation(counters, name)
      const activityName = `${name}#${invocation}`
      const payloadSchema = jsonSchemaOf(schema)
      return Effect.tryPromise({
        try: async () => {
          await recordCall({ kind: "signal", name, counter: invocation })
          signals.registerSchema(executionId, name, schema)
          await emit({
            type: "signal.waiting",
            executionId,
            name,
            invocation,
            activityName,
            timeout: opts?.timeout,
            ...(payloadSchema === undefined ? {} : { payloadSchema })
          })

          const buffered = signals.takeBuffered(executionId, name, schema)
          if (buffered.present) {
            await emit({
              type: "signal.received",
              executionId,
              name,
              invocation,
              activityName,
              payload: buffered.value
            })
            return { type: "signal", value: buffered.value } as const
          }

          if (options.signalValue !== undefined) {
            const value = decodeSync(schema, await options.signalValue({ executionId, name, schema }))
            await emit({
              type: "signal.received",
              executionId,
              name,
              invocation,
              activityName,
              payload: value
            })
            return { type: "signal", value } as const
          }

          if (opts?.timeout !== undefined) {
            if (options.signalTimeout !== undefined) {
              const controller = new AbortController()
              const outcome = await Promise.race([
                signals.await(executionId, name, schema, { signal: controller.signal })
                  .then((value) => ({ type: "signal", value }) as const),
                options.signalTimeout({ executionId, name: activityName, duration: opts.timeout })
                  .then(() => ({ type: "timeout" }) as const)
              ]).finally(() => controller.abort())
              if (outcome.type === "signal") {
                await emit({
                  type: "signal.received",
                  executionId,
                  name,
                  invocation,
                  activityName,
                  payload: outcome.value
                })
              } else {
                await emit({
                  type: "signal.timeout",
                  executionId,
                  name,
                  invocation,
                  activityName,
                  timeout: opts.timeout
                })
              }
              return outcome
            }
            await emit({
              type: "signal.timeout",
              executionId,
              name,
              invocation,
              activityName,
              timeout: opts.timeout
            })
            return { type: "timeout" } as const
          }

          const value = await signals.await(executionId, name, schema)
          await emit({
            type: "signal.received",
            executionId,
            name,
            invocation,
            activityName,
            payload: value
          })
          return { type: "signal", value } as const
        },
        catch: (error) => new AsyncFailure(error)
      }).pipe(Effect.mapError(unwrapAsyncFailure)) as Effect.Effect<any, any, any>
    },

    now() {
      const invocation = nextInvocation(counters, "now")
      const call: OrchestrationCall = { kind: "now", name: "now", counter: invocation }
      return Effect.promise(async () => {
        await recordCall(call)
        const key = orchestrationValueKey(call)
        const existing = determinism.values.get(key)
        if (existing instanceof Date) {
          return existing
        }
        const value = new Date()
        determinism.values.set(key, value)
        return value
      })
    },

    random() {
      const invocation = nextInvocation(counters, "random")
      const call: OrchestrationCall = { kind: "random", name: "random", counter: invocation }
      return Effect.promise(async () => {
        await recordCall(call)
        const key = orchestrationValueKey(call)
        const existing = determinism.values.get(key)
        if (typeof existing === "number") {
          return existing
        }
        const value = Math.random()
        determinism.values.set(key, value)
        return value
      })
    },

    code(name, options) {
      const invocation = nextInvocation(counters, name)
      const activityName = `${name}#${invocation}`
      const call: OrchestrationCall = { kind: "code", name, counter: invocation }
      return Effect.tryPromise({
        try: async () => {
          await recordCall(call)
          await emit({
            type: "code.started",
            executionId,
            name,
            invocation,
            activityName,
            ...(options.reason === undefined ? {} : { reason: options.reason })
          })

          const key = orchestrationValueKey(call)
          if (determinism.values.has(key)) {
            const result = determinism.values.get(key)
            await emit({
              type: "code.completed",
              executionId,
              name,
              invocation,
              activityName,
              ...(options.reason === undefined ? {} : { reason: options.reason }),
              result
            })
            return result as Awaited<ReturnType<typeof options.run>>
          }

          try {
            const result = await options.run()
            determinism.values.set(key, result)
            await emit({
              type: "code.completed",
              executionId,
              name,
              invocation,
              activityName,
              ...(options.reason === undefined ? {} : { reason: options.reason }),
              result
            })
            return result
          } catch (error) {
            await emit({
              type: "code.failed",
              executionId,
              name,
              invocation,
              activityName,
              ...(options.reason === undefined ? {} : { reason: options.reason }),
              error
            })
            throw error
          }
        },
        catch: (error) => new AsyncFailure(error)
      }).pipe(Effect.mapError(unwrapAsyncFailure)) as Effect.Effect<any, any, any>
    },

    all(effects, options) {
      const name = options?.name ?? "all"
      const invocation = nextInvocation(counters, name)
      const activityName = `${name}#${invocation}`
      const branches = effects.length
      const call: OrchestrationCall = { kind: "all", name, counter: invocation, branches }
      const record = Effect.tryPromise({
        try: () => recordCall(call),
        catch: (error): NonDeterminismError => error as NonDeterminismError
      })
      const emitEvent = (event: WorkflowEvent) => Effect.promise(() => emit(event))
      const persistBlock = (branchCalls: OrchestrationCall[][]) =>
        Effect.sync(() => {
          if (determinism.blocks[blockPosition++] === undefined) {
            determinism.blocks.push({ call, branches: branchCalls })
          }
        })
      return Effect.gen(function* () {
        yield* record
        yield* emitEvent({
          type: "all.started",
          executionId,
          name,
          invocation,
          activityName,
          branches
        })
        const branchCalls: OrchestrationCall[][] = []
        const wrapped = effects.map((effect) =>
          Effect.acquireUseRelease(
            Effect.sync(() => {
              const calls: OrchestrationCall[] = []
              branchCalls.push(calls)
              branchCollectors.push(calls)
            }),
            () => effect as Effect.Effect<any, any, any>,
            () => Effect.sync(() => {
              branchCollectors.pop()
            })
          )
        )
        return yield* (Effect.all(wrapped, { concurrency: 1 }) as Effect.Effect<any, any, any>).pipe(
          Effect.tap(() =>
            Effect.gen(function* () {
              yield* persistBlock(branchCalls)
              yield* emitEvent({
                type: "all.completed",
                executionId,
                name,
                invocation,
                activityName,
                branches
              })
            })
          ),
          Effect.tapError((error) =>
            Effect.gen(function* () {
              yield* persistBlock(branchCalls)
              yield* emitEvent({
                type: "all.failed",
                executionId,
                name,
                invocation,
                activityName,
                branches,
                error
              })
            })
          )
        )
      }) as Effect.Effect<any, any, any>
    },

    fail(error) {
      return Effect.fail(decodeSync(workflowErrors, error))
    },

    effect(effect) {
      return effect as Effect.Effect<any, any, any>
    }
  }
}

const isDeclaredTerminal = <E>(schema: AnySchema<E>, error: unknown): boolean => {
  try {
    decodeSync(schema, error)
    return true
  } catch {
    return false
  }
}

export const defineWorkflow = <
  const Input extends AnySchema,
  const Output extends AnySchema,
  const Errors extends AnySchema = typeof Schema.Never
>(config: {
  readonly name: string
  readonly input: Input
  readonly output: Output
  readonly errors?: Errors
  readonly run: (
    input: Schema.Schema.Type<Input>,
    ctx: WorkflowContext<Schema.Schema.Type<Errors>>
  ) => Generator<any, Schema.Schema.Type<Output>, any>
}): DefinedWorkflow<Schema.Schema.Type<Input>, Schema.Schema.Type<Output>, Schema.Schema.Type<Errors>> => {
  const errors = config.errors ?? Schema.Never
  const sourceHash = createHash("sha256")
    .update(config.name)
    .update("\0")
    .update(config.run.toString())
    .digest("hex")

  const workflow = Workflow.make({
    name: config.name,
    payload: WorkflowPayloadSchema,
    idempotencyKey: (payload) => JSON.stringify(payload.value),
    success: config.output,
    error: Schema.Unknown
  })

  const layer = workflow.toLayer(
    Effect.fn(function* (
      payload: { readonly value: Schema.Schema.Type<Input> },
      executionId: string
    ) {
      const input = decodeSync(config.input, payload.value)
      const result = yield* config.run(input, makeCtx(workflow, ExecutionId.make(executionId), errors)) as any
      return decodeSync(config.output, result)
    }) as any
  )

  const executeInMemory = async (
    payload: Schema.Schema.Type<Input>,
    options: InMemoryExecutionOptions = {}
  ): Promise<Schema.Schema.Type<Output>> => {
    const executionId = ExecutionId.make(options.executionId ?? `memory-${crypto.randomUUID()}`)
    const compensations: CompensationEntry[] = []
    const determinism = options.determinism ?? createInMemoryDeterminismState()
    const input = decodeSync(config.input, payload)
    const emit = async (event: WorkflowEvent) => {
      await options.onEvent?.(event)
    }
    const ctx = makeInMemoryCtx(executionId, errors, compensations, determinism, emit, {
      ...(options.stepExecutors === undefined ? {} : { stepExecutors: options.stepExecutors }),
      ...(options.stepExecutor === undefined ? {} : { stepExecutor: options.stepExecutor }),
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
      ...(options.signalTimeout === undefined ? {} : { signalTimeout: options.signalTimeout }),
      ...(options.signalValue === undefined ? {} : { signalValue: options.signalValue }),
      ...(options.signalTransport === undefined ? {} : { signalTransport: options.signalTransport }),
      ...(options.secrets === undefined ? {} : { secrets: options.secrets }),
      ...(options.integrations === undefined ? {} : { integrations: options.integrations }),
      ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency })
    })

    const effect = Effect.gen(function* () {
      return yield* config.run(input, ctx) as any
    }).pipe(
      Effect.map((result) => decodeSync(config.output, result)),
      Effect.catch((error) =>
        Effect.gen(function* () {
          if (skipsCompensation(error)) {
            return yield* Effect.fail(error)
          }
          for (const compensation of compensations.slice().reverse()) {
            yield* emitWorkflowEvent({
              type: "compensation.started",
              executionId,
              stepName: compensation.stepName,
              invocation: compensation.invocation,
              activityName: `${compensation.stepName}#${compensation.invocation}`,
              result: compensation.result,
              input: compensation.input,
              reason: error
            })
            yield* Effect.promise(() =>
              Promise.resolve(
                compensation.compensate(compensation.result, compensation.input, error)
              )
            ).pipe(
              Effect.tapError((compensationError) =>
                emitWorkflowEvent({
                  type: "compensation.failed",
                  executionId,
                  stepName: compensation.stepName,
                  invocation: compensation.invocation,
                  activityName: `${compensation.stepName}#${compensation.invocation}`,
                  error: compensationError
                })
              ),
              Effect.orDie
            )
            yield* emitWorkflowEvent({
              type: "compensation.completed",
              executionId,
              stepName: compensation.stepName,
              invocation: compensation.invocation,
              activityName: `${compensation.stepName}#${compensation.invocation}`
            })
          }
          return yield* Effect.fail(error)
        })
      )
    )

    const resources = makeExecutionResourceRegistry({
      ...(options.onEvent === undefined ? {} : { events: options.onEvent }),
      ...(options.secrets === undefined ? {} : { secrets: options.secrets }),
      ...(options.integrations === undefined ? {} : { integrations: options.integrations }),
      ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
      ...(options.signalTransport === undefined ? {} : { signals: options.signalTransport })
    })

    const exit = await Effect.runPromiseExit(
      effect.pipe(
        Effect.provideService(ExecutionResourceRegistry, resources)
      ) as Effect.Effect<Schema.Schema.Type<Output>, unknown, never>
    )
    if (Exit.isSuccess(exit)) {
      return exit.value
    }
    const failure = Option.getOrUndefined(Cause.findErrorOption(exit.cause))
    throw failure ?? Cause.squash(exit.cause)
  }

  return {
    [DefinedWorkflowTypeId]: DefinedWorkflowTypeId,
    name: config.name,
    sourceHash,
    input: config.input,
    output: config.output,
    errors,
    workflow,
    layer,
    execute: (payload) => {
      const enginePayload = Schema.decodeUnknownSync(WorkflowPayloadSchema)({ value: payload })
      return workflow.execute(enginePayload) as Effect.Effect<
        Schema.Schema.Type<Output>,
        Schema.Schema.Type<Errors> | unknown,
        any
      >
    },
    executeInMemory
  }
}
