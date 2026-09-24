import { Clock, Duration, Effect, Schedule } from "effect"
import type { BlobStore, StorageError } from "@integragents/host"
import type { GatewayStore, GatewayStoreError } from "./store.ts"

const blobRetention = Duration.days(7)

export type MaintenanceResult = {
  readonly expiredApprovals: number
  readonly expiredAuditArguments: number
  readonly deletedSessions: number
  readonly expiredIdentityFlows: number
  readonly expiredOAuthState: number
  readonly expiredBlobs: number
}

export const runMaintenance = Effect.fn("Maintenance.run")(function*(
  store: GatewayStore,
  blobs: BlobStore["Service"],
  cutoff?: Date
): Effect.fn.Return<MaintenanceResult, GatewayStoreError | StorageError> {
  const at = cutoff ?? new Date(yield* Clock.currentTimeMillis)
  return {
    expiredApprovals: yield* store.expireApprovals(at),
    expiredAuditArguments: yield* store.expireAuditArguments(at),
    deletedSessions: yield* store.deleteExpiredSessions(at),
    expiredIdentityFlows: yield* store.deleteExpiredIdentityFlows(at),
    expiredOAuthState: yield* store.deleteExpiredOAuthState(at),
    expiredBlobs: yield* blobs.expire(new Date(at.getTime() - Duration.toMillis(blobRetention)))
  }
})

/** Sweeps forever on the interval; a failed sweep is logged and the next one still runs. */
export const maintenanceLoop = <E, R>(
  store: GatewayStore,
  blobs: BlobStore["Service"],
  options: {
    readonly interval?: Schedule.Schedule<unknown>
    readonly afterSweep: Effect.Effect<void, E, R>
  }
): Effect.Effect<never, never, R> =>
  runMaintenance(store, blobs).pipe(
    Effect.andThen(options.afterSweep),
    Effect.catchCause((cause) =>
      Effect.logWarning("gateway maintenance sweep failed", cause).pipe(
        Effect.annotateLogs({ operation: "Maintenance.sweep" })
      )),
    Effect.repeat(options.interval ?? Schedule.spaced("1 minute")),
    Effect.andThen(Effect.never)
  )
