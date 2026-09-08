import { Effect } from "effect"
import type { GatewayStore, GatewayStoreError } from "./store.ts"

export type MaintenanceResult = {
  readonly expiredApprovals: number
  readonly expiredAuditArguments: number
  readonly deletedSessions: number
  readonly expiredIdentityFlows: number
}

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

export const startMaintenanceLoop = (
  store: GatewayStore,
  options: {
    readonly intervalMs?: number
    readonly onError?: (error: GatewayStoreError) => void
    readonly afterSweep?: () => Effect.Effect<void, GatewayStoreError>
  } = {}
): MaintenanceLoop => {
  const interval = setInterval(() => {
    Effect.runFork(runMaintenance(store).pipe(
      Effect.andThen(options.afterSweep?.() ?? Effect.void),
      Effect.catch((error) => Effect.sync(() => options.onError?.(error)))
    ))
  }, options.intervalMs ?? 60_000)
  interval.unref?.()
  return { stop: () => clearInterval(interval) }
}
