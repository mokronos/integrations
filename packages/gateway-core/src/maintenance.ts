import { Clock, Duration, Effect, Schedule } from "effect"
import type { Crypto } from "effect"
import type { BlobStore, StorageError } from "@integragents/integrations"
import { Alias } from "./domain.ts"
import { newAuditId } from "./keys.ts"
import type { GatewayStore, GatewayStoreError } from "./store/index.ts"

const blobRetention = Duration.days(7)

/** How long an approved call may run before maintenance takes it for interrupted. */
export const defaultExecutionLease = Duration.hours(1)

export const interruptedExecutionMessage =
  "outcome unknown: the execution was interrupted before it recorded a result, and was not run again. " +
  "Check the target before calling it again."

export interface MaintenanceOptions {
  /** How long an approved call may run before it counts as interrupted; an hour when absent. */
  readonly executionLease?: Duration.Input
}

/** How long the outcome of a call made with an idempotency key answers its repeats. */
const invocationKeyRetention = Duration.days(30)

export type MaintenanceResult = {
  readonly expiredApprovals: number
  readonly interruptedApprovals: number
  /** Keyed calls that never recorded an outcome, settled as unknown. */
  readonly interruptedInvocations: number
  readonly expiredInvocationKeys: number
  readonly expiredAuditArguments: number
  readonly deletedSessions: number
  readonly expiredIdentityFlows: number
  readonly expiredOAuthState: number
  readonly expiredBlobs: number
}

/**
 * Settles the approved calls whose execution was interrupted, such as by a
 * crash, as failed with an unknown outcome, and records each in the audit
 * trail. Running them again could do twice what was asked once.
 */
const settleInterrupted = Effect.fn("Maintenance.settleInterrupted")(function* (
  store: GatewayStore,
  claimedBefore: Date
): Effect.fn.Return<number, GatewayStoreError, Crypto.Crypto> {
  const settled = yield* store.settleInterruptedApprovals(claimedBefore, interruptedExecutionMessage)
  yield* Effect.forEach(
    settled,
    ({ tenantId, approval }) =>
      Effect.flatMap(newAuditId, (id) =>
        store.recordAudit({
          tenantId,
          id,
          profileId: approval.profileId,
          caller: approval.caller,
          authorizedBySubjectId: null,
          alias: Alias.make(approval.alias),
          tool: approval.tool,
          connection: null,
          decision: "require_approval",
          approval: "approved",
          outcome: "failed",
          message: `approval ${approval.id}: ${interruptedExecutionMessage}`
        })
      ),
    { discard: true }
  )
  return settled.length
})

export const runMaintenance = Effect.fn("Maintenance.run")(function* (
  store: GatewayStore,
  blobs: BlobStore["Service"],
  cutoff?: Date,
  options: MaintenanceOptions = {}
): Effect.fn.Return<MaintenanceResult, GatewayStoreError | StorageError, Crypto.Crypto> {
  const at = cutoff ?? new Date(yield* Clock.currentTimeMillis)
  const lease = Duration.toMillis(Duration.fromInputUnsafe(options.executionLease ?? defaultExecutionLease))
  return {
    expiredApprovals: (yield* store.expireApprovals(at)).length,
    interruptedApprovals: yield* settleInterrupted(store, new Date(at.getTime() - lease)),
    interruptedInvocations: yield* store.settleInterruptedInvocationKeys(new Date(at.getTime() - lease), {
      status: "failed",
      message: interruptedExecutionMessage
    }),
    expiredInvocationKeys: yield* store.expireInvocationKeys(
      new Date(at.getTime() - Duration.toMillis(invocationKeyRetention))
    ),
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
  options: MaintenanceOptions & {
    readonly interval?: Schedule.Schedule<unknown>
    readonly afterSweep: Effect.Effect<void, E, R>
  }
): Effect.Effect<never, never, R | Crypto.Crypto> =>
  runMaintenance(store, blobs, undefined, options).pipe(
    Effect.andThen(options.afterSweep),
    Effect.catchCause((cause) =>
      Effect.logWarning("gateway maintenance sweep failed", cause).pipe(
        Effect.annotateLogs({ operation: "Maintenance.sweep" })
      )
    ),
    Effect.repeat(options.interval ?? Schedule.spaced("1 minute")),
    Effect.andThen(Effect.never)
  )
