import { Effect } from "effect"
import type { GatewayStore, GatewayStoreError } from "./store.ts"

export type MaintenanceResult = {
  readonly expiredApprovals: number
  readonly expiredAuditArguments: number
  /** Signed-in humans whose session simply ran out. */
  readonly deletedSessions: number
  /** Abandoned Google redirects and one-time CLI login handoffs. */
  readonly expiredIdentityFlows: number
}

/** The things that must happen on a clock rather than on a request.
 *
 * Each is a decision, not a cleanup. An approval that expired did not "fail to
 * be answered" — the answer is that the invocation does not happen. Arguments
 * that aged out are the deliberate half of the audit split: the record stays
 * forever, the payload does not. */
export const runMaintenance = Effect.fn("Maintenance.run")(function*(
  store: GatewayStore,
  at: Date = new Date()
): Effect.fn.Return<MaintenanceResult, GatewayStoreError> {
  return {
    expiredApprovals: yield* store.expireApprovals(at),
    expiredAuditArguments: yield* store.expireAuditArguments(at),
    deletedSessions: yield* store.deleteExpiredSessions(at),
    expiredIdentityFlows: yield* store.deleteExpiredIdentityFlows(at)
  }
})

export interface MaintenanceLoop {
  stop(): void
}

/** Runs the sweep on an interval. Deliberately fire-and-forget with errors
 * swallowed to a callback: a maintenance failure must never take the gateway
 * down, and the next tick retries anyway. */
export const startMaintenanceLoop = (
  store: GatewayStore,
  options: {
    readonly intervalMs?: number
    readonly onError?: (error: GatewayStoreError) => void
  } = {}
): MaintenanceLoop => {
  const interval = setInterval(() => {
    Effect.runFork(runMaintenance(store).pipe(
      Effect.catch((error) => Effect.sync(() => options.onError?.(error)))
    ))
  }, options.intervalMs ?? 60_000)
  // Never hold the process open on our account.
  interval.unref?.()
  return { stop: () => clearInterval(interval) }
}
