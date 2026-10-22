import { Context, Effect, Layer, Schema } from "effect"
import { InvocationDenied, InvocationFailed, InvocationSucceeded } from "@integragents/contracts"
import { Alias, ApprovalId, IdempotencyKey, ToolName, canonicalJson } from "../domain.ts"
import type { ProfileId, SubjectId, TenantId } from "../domain.ts"
import { millis, Millis } from "./columns.ts"
import { now, operation, stored, StoreSql } from "./sql.ts"
import type { GatewayStoreError } from "./sql.ts"

/** What a keyed call is remembered with once it settles: it ran, failed, or was refused. */
export const RememberedOutcome = Schema.Union([InvocationSucceeded, InvocationFailed, InvocationDenied])
export type RememberedOutcome = typeof RememberedOutcome.Type

/** What a call made with an idempotency key has come to so far. */
export interface InvocationKeyRecord {
  readonly key: IdempotencyKey
  readonly alias: Alias
  readonly tool: ToolName
  /** Whether the repeat names the same alias, tool, subject and arguments as the call that took the key. */
  readonly sameCall: boolean
  readonly status: "running" | "pending" | "settled"
  readonly approvalId: ApprovalId | null
  readonly outcome: RememberedOutcome | null
  readonly createdAt: Date
}

/** A call as its idempotency key binds it. */
export interface KeyedCall {
  readonly alias: Alias
  readonly tool: ToolName
  readonly subject: SubjectId | null
  readonly arguments: typeof Schema.Json.Type
}

interface KeyAddress {
  readonly tenantId: TenantId
  readonly profileId: ProfileId
  readonly key: IdempotencyKey
}

/** Idempotency keys, so a retried call gets the first call's outcome instead of running again. */
export interface InvocationKeyStore {
  /**
   * Takes an idempotency key for a call, as `running`. Answers nothing when
   * the key was free, or what the call that took it first has come to.
   */
  claimInvocationKey(
    input: KeyAddress & { readonly call: KeyedCall }
  ): Effect.Effect<InvocationKeyRecord | undefined, GatewayStoreError>
  /** Moves a key on from `from`: to `pending` on an approval, or to `settled` with an outcome. */
  settleInvocationKey(
    input: KeyAddress & {
      readonly from: "running" | "pending"
      readonly to: { readonly approvalId: ApprovalId } | { readonly outcome: RememberedOutcome }
    }
  ): Effect.Effect<boolean, GatewayStoreError>
  /** Frees a key that is still `running`, for a call that ended without anything worth remembering. */
  releaseInvocationKey(input: KeyAddress): Effect.Effect<void, GatewayStoreError>
  /** Settles keys still `running` since `claimedBefore` with `outcome`; answers how many. */
  settleInterruptedInvocationKeys(
    claimedBefore: Date,
    outcome: RememberedOutcome
  ): Effect.Effect<number, GatewayStoreError>
  /** Forgets keys settled at or before `settledBefore`; answers how many. */
  expireInvocationKeys(settledBefore: Date): Effect.Effect<number, GatewayStoreError>
}

const InvocationKeyRow = Schema.Struct({
  idempotency_key: IdempotencyKey,
  fingerprint: Schema.String,
  alias: Alias,
  tool: ToolName,
  status: Schema.Literals(["running", "pending", "settled"]),
  approval_id: Schema.NullOr(ApprovalId),
  outcome: Schema.NullOr(Schema.String),
  created_at: Millis
})

const encodeRememberedOutcome = Schema.encodeSync(Schema.fromJsonString(RememberedOutcome))

export class InvocationKeyStoreService extends Context.Service<InvocationKeyStoreService, InvocationKeyStore>()(
  "@integragents/gateway-core/InvocationKeyStore"
) {
  static readonly layer = Layer.effect(
    InvocationKeyStoreService,
    Effect.map(StoreSql, (db): InvocationKeyStore => ({
      claimInvocationKey: (input) =>
        operation(
          "claimInvocationKey",
          Effect.gen(function* () {
            const fingerprint = db.encryption.lookup(
              canonicalJson({
                alias: input.call.alias,
                tool: input.call.tool,
                subject: input.call.subject,
                arguments: input.call.arguments
              })
            )
            const taken = yield* db.changed(
              `INSERT INTO gateway_invocation_key
             (tenant_id, profile_id, idempotency_key, fingerprint, alias, tool, status, approval_id, outcome,
              created_at, settled_at)
           VALUES (?, ?, ?, ?, ?, ?, 'running', NULL, NULL, ?, NULL)
           ON CONFLICT DO NOTHING
           RETURNING idempotency_key`,
              [input.tenantId, input.profileId, input.key, fingerprint, input.call.alias, input.call.tool, yield* now]
            )
            if (taken === 1) return undefined
            const row = yield* stored(
              db.one(
                InvocationKeyRow,
                "SELECT * FROM gateway_invocation_key WHERE tenant_id = ? AND profile_id = ? AND idempotency_key = ?",
                [input.tenantId, input.profileId, input.key]
              ),
              `idempotency key ${input.key}`
            )
            const record: InvocationKeyRecord = {
              key: row.idempotency_key,
              alias: row.alias,
              tool: row.tool,
              sameCall: row.fingerprint === fingerprint,
              status: row.status,
              approvalId: row.approval_id,
              outcome: row.outcome === null ? null : yield* db.openJson(RememberedOutcome, row.outcome),
              createdAt: row.created_at
            }
            return record
          })
        ),

      settleInvocationKey: (input) =>
        operation(
          "settleInvocationKey",
          Effect.gen(function* () {
            const to = input.to
            const settled = "outcome" in to
            const changed = yield* db.changed(
              `UPDATE gateway_invocation_key
              SET status = ?, approval_id = COALESCE(?, approval_id), outcome = ?, settled_at = ?
            WHERE tenant_id = ? AND profile_id = ? AND idempotency_key = ? AND status = ?
            RETURNING idempotency_key`,
              [
                settled ? "settled" : "pending",
                settled ? null : to.approvalId,
                settled ? db.seal(encodeRememberedOutcome(to.outcome)) : null,
                settled ? yield* now : null,
                input.tenantId,
                input.profileId,
                input.key,
                input.from
              ]
            )
            return changed === 1
          })
        ),

      releaseInvocationKey: (input) =>
        operation(
          "releaseInvocationKey",
          db.run(
            `DELETE FROM gateway_invocation_key
          WHERE tenant_id = ? AND profile_id = ? AND idempotency_key = ? AND status = 'running'`,
            [input.tenantId, input.profileId, input.key]
          )
        ),

      settleInterruptedInvocationKeys: (claimedBefore, outcome) =>
        operation(
          "settleInterruptedInvocationKeys",
          Effect.gen(function* () {
            return yield* db.changed(
              `UPDATE gateway_invocation_key SET status = 'settled', outcome = ?, settled_at = ?
            WHERE status = 'running' AND created_at <= ?
            RETURNING idempotency_key`,
              [db.seal(encodeRememberedOutcome(outcome)), yield* now, millis(claimedBefore)]
            )
          })
        ),

      expireInvocationKeys: (settledBefore) =>
        operation(
          "expireInvocationKeys",
          db.changed(
            "DELETE FROM gateway_invocation_key WHERE status = 'settled' AND settled_at <= ? RETURNING idempotency_key",
            [millis(settledBefore)]
          )
        )
    }))
  )
}
