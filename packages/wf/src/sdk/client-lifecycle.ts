import { isTerminalRunStatus } from "../run-lifecycle.ts"
import type { WorkflowHistoryRecord } from "../schemas.ts"
import type {
  PendingSignal,
  WorkflowClient,
  WorkflowObservation
} from "./sdk.ts"

export const nowIso = (): string => new Date().toISOString()

export const optionalActor = (
  actor: string | undefined
): { readonly actor?: string } => actor === undefined ? {} : { actor }

export const optionalFinishedAt = (
  finishedAt: string | undefined
): { readonly finishedAt?: string } => finishedAt === undefined ? {} : { finishedAt }

export const optionalCursor = (
  cursor: string | undefined
): { readonly cursor?: string } => cursor === undefined ? {} : { cursor }

const signalKey = (event: { readonly name: string; readonly invocation: number }): string =>
  `${event.name}:${event.invocation}`

const optionalTimeout = (timeout: unknown): { readonly timeout?: unknown } =>
  timeout === undefined ? {} : { timeout }

const waitForObservationTick = (
  signal: AbortSignal | undefined
): Promise<void> => new Promise((resolve, reject) => {
  const timeout = setTimeout(finish, 50)
  const abort = () => {
    clearTimeout(timeout)
    reject(signal?.reason ?? new Error("Workflow observation aborted"))
  }
  function finish() {
    signal?.removeEventListener("abort", abort)
    resolve()
  }
  if (signal?.aborted === true) {
    abort()
    return
  }
  signal?.addEventListener("abort", abort, { once: true })
})

export const observeExecution = async (
  client: Pick<WorkflowClient, "status" | "result" | "pendingSignals">,
  executionId: string,
  signal: AbortSignal | undefined
): Promise<WorkflowObservation> => {
  void client.result(executionId)
  while (true) {
    const status = await client.status(executionId)
    if (isTerminalRunStatus(status)) {
      return { type: "terminal", result: await client.result(executionId) }
    }
    if (status === "suspended") {
      const pendingSignals = await client.pendingSignals(executionId)
      if (pendingSignals.length > 0) {
        return { type: "signal-suspended", pendingSignals }
      }
    }
    await waitForObservationTick(signal)
  }
}

export const pendingSignalsFromHistory = (
  history: ReadonlyArray<WorkflowHistoryRecord>
): ReadonlyArray<PendingSignal> => {
  const consumed = new Set<string>()
  for (const record of history) {
    const event = record.event
    if (event.type === "signal.received" || event.type === "signal.timeout") {
      consumed.add(signalKey(event))
    }
  }

  return history.flatMap((record) => {
    const event = record.event
    if (event.type !== "signal.waiting" || consumed.has(signalKey(event))) return []
    return [{
      name: event.name,
      invocation: event.invocation,
      activityName: event.activityName,
      ...optionalTimeout(event.timeout),
      ...(event.payloadSchema === undefined ? {} : { payloadSchema: event.payloadSchema })
    }]
  })
}
