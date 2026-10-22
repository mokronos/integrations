import { Context, Effect, Layer, Schema } from "effect"
import {
  Alias,
  ApprovalDeliveryId,
  ApprovalDeliveryStatus,
  ApprovalDestinationId,
  ApprovalId,
  ApprovalStatus,
  ProfileId,
  TenantId,
  ToolName
} from "../domain.ts"
import type { ApprovalDeliveryAttempt, ApprovalDestination } from "../domain.ts"
import { Expiry, millis, Millis, nullableMillis, NullableMillis } from "./columns.ts"
import { now, operation, placeholders, stored, StoreSql } from "./sql.ts"
import type { GatewayStoreError } from "./sql.ts"

export interface ApprovalDeliveryJob extends ApprovalDeliveryAttempt {
  readonly tenantId: TenantId
  readonly groupId: ApprovalId
  readonly profileId: ProfileId
  readonly profileName: string
  readonly alias: Alias
  readonly tool: ToolName
  readonly expiresAt: Date | null
  readonly url: string
  readonly signingSecret: string
}

/** An `approval.decided` notification due at one destination. */
export interface ApprovalDecisionDeliveryJob {
  readonly id: ApprovalDeliveryId
  readonly approvalId: ApprovalId
  readonly attempts: number
  readonly createdAt: Date
  readonly tenantId: TenantId
  readonly groupId: ApprovalId
  readonly profileId: ProfileId
  readonly profileName: string
  readonly alias: Alias
  readonly tool: ToolName
  readonly status: "approved" | "denied" | "expired"
  readonly failed: boolean
  readonly decidedBy: string | null
  readonly decidedAt: Date | null
  readonly url: string
  readonly signingSecret: string
}

export interface DeliveryOutcome {
  readonly id: ApprovalDeliveryId
  readonly status: "delivered" | "retrying" | "failed"
  readonly nextAttemptAt: Date | null
  readonly error: string | null
}

/** Where a profile's approvals are announced, and each announcement still owed. */
export interface ApprovalDeliveryStore {
  createApprovalDestination(input: {
    readonly id: ApprovalDestinationId
    readonly tenantId: TenantId
    readonly name: string
    readonly url: string
    readonly signingSecret: string
  }): Effect.Effect<ApprovalDestination, GatewayStoreError>
  listApprovalDestinations(tenantId: TenantId): Effect.Effect<ReadonlyArray<ApprovalDestination>, GatewayStoreError>
  deleteApprovalDestination(tenantId: TenantId, id: ApprovalDestinationId): Effect.Effect<void, GatewayStoreError>
  listProfileApprovalDestinationIds(
    profileId: ProfileId
  ): Effect.Effect<ReadonlyArray<ApprovalDestinationId>, GatewayStoreError>
  replaceProfileApprovalDestinations(
    tenantId: TenantId,
    profileId: ProfileId,
    ids: ReadonlyArray<ApprovalDestinationId>
  ): Effect.Effect<ReadonlyArray<ApprovalDestinationId>, GatewayStoreError>
  listApprovalDeliveries(
    tenantId: TenantId,
    status?: ApprovalStatus
  ): Effect.Effect<ReadonlyArray<ApprovalDeliveryAttempt>, GatewayStoreError>
  claimDueApprovalDeliveries(
    now: Date,
    limit: number
  ): Effect.Effect<ReadonlyArray<ApprovalDeliveryJob>, GatewayStoreError>
  settleApprovalDelivery(input: DeliveryOutcome): Effect.Effect<void, GatewayStoreError>
  claimDueApprovalDecisionDeliveries(
    now: Date,
    limit: number
  ): Effect.Effect<ReadonlyArray<ApprovalDecisionDeliveryJob>, GatewayStoreError>
  settleApprovalDecisionDelivery(input: DeliveryOutcome): Effect.Effect<void, GatewayStoreError>
}

const DestinationRow = Schema.Struct({
  id: ApprovalDestinationId,
  tenantId: TenantId,
  name: Schema.String,
  type: Schema.Literal("webhook"),
  url: Schema.String,
  createdAt: Millis
}).pipe(Schema.encodeKeys({ tenantId: "tenant_id", createdAt: "created_at" }))

const DestinationIdRow = Schema.Struct({ destination_id: ApprovalDestinationId })

const deliveryAttemptFields = {
  id: ApprovalDeliveryId,
  approvalId: ApprovalId,
  destinationId: ApprovalDestinationId,
  destinationName: Schema.String,
  status: ApprovalDeliveryStatus,
  attempts: Schema.Number,
  nextAttemptAt: NullableMillis,
  deliveredAt: NullableMillis,
  lastError: Schema.NullOr(Schema.String)
}

const deliveryAttemptKeys = {
  approvalId: "approval_id",
  destinationId: "destination_id",
  destinationName: "destination_name",
  nextAttemptAt: "next_attempt_at",
  deliveredAt: "delivered_at",
  lastError: "last_error"
} as const

const DeliveryAttemptRow = Schema.Struct(deliveryAttemptFields).pipe(Schema.encodeKeys(deliveryAttemptKeys))

/** The delivery as the oldest call of its group that still waits sees it. */
const DeliveryJobRow = Schema.Struct({
  ...deliveryAttemptFields,
  waitingId: ApprovalId,
  tenantId: TenantId,
  groupId: ApprovalId,
  profileId: ProfileId,
  profileName: Schema.String,
  alias: Alias,
  tool: ToolName,
  expiresAt: Expiry,
  url: Schema.String,
  signingSecret: Schema.String
}).pipe(
  Schema.encodeKeys({
    ...deliveryAttemptKeys,
    waitingId: "waiting_id",
    tenantId: "tenant_id",
    groupId: "group_id",
    profileId: "profile_id",
    profileName: "profile_name",
    expiresAt: "expires_at",
    signingSecret: "signing_secret"
  })
)

const DecisionDeliveryRow = Schema.Struct({
  id: ApprovalDeliveryId,
  approvalId: ApprovalId,
  attempts: Schema.Number,
  createdAt: Millis,
  tenantId: TenantId,
  groupId: Schema.NullOr(ApprovalId),
  profileId: ProfileId,
  profileName: Schema.String,
  alias: Alias,
  tool: ToolName,
  status: ApprovalStatus,
  error: Schema.NullOr(Schema.String),
  decidedBy: Schema.NullOr(Schema.String),
  decidedAt: NullableMillis,
  url: Schema.String,
  signingSecret: Schema.String
}).pipe(
  Schema.encodeKeys({
    approvalId: "approval_id",
    createdAt: "created_at",
    tenantId: "tenant_id",
    groupId: "group_id",
    profileId: "profile_id",
    profileName: "profile_name",
    decidedBy: "decided_by",
    decidedAt: "decided_at",
    signingSecret: "signing_secret"
  })
)

const ClaimedRow = Schema.Struct({ id: ApprovalDeliveryId })

/** A claim holds a delivery for a minute, so a crashed sender's job comes due again. */
const claimLease = 60_000

export class ApprovalDeliveryStoreService extends Context.Service<
  ApprovalDeliveryStoreService,
  ApprovalDeliveryStore
>()("@integragents/gateway-core/ApprovalDeliveryStore") {
  static readonly layer = Layer.effect(
    ApprovalDeliveryStoreService,
    Effect.gen(function* () {
      const db = yield* StoreSql
      const profileDestinationIds = (profileId: ProfileId) =>
        Effect.map(
          db.all(
            DestinationIdRow,
            "SELECT destination_id FROM gateway_profile_approval_destination WHERE profile_id = ? ORDER BY destination_id",
            [profileId]
          ),
          (rows) => rows.map((row) => row.destination_id)
        )

      const settle = (table: string, input: DeliveryOutcome) =>
        Effect.gen(function* () {
          yield* db.run(
            `UPDATE ${table}
            SET status = ?, attempts = attempts + 1, next_attempt_at = ?,
                delivered_at = CASE WHEN ? = 'delivered' THEN ? ELSE delivered_at END,
                last_error = ?
          WHERE id = ?`,
            [input.status, nullableMillis(input.nextAttemptAt), input.status, yield* now, input.error, input.id]
          )
        })

      return {
        createApprovalDestination: (input) =>
          operation(
            "createApprovalDestination",
            Effect.gen(function* () {
              yield* db.run(
                `INSERT INTO gateway_approval_destination
               (id, tenant_id, name, type, url, signing_secret, created_at, deleted_at)
             VALUES (?, ?, ?, 'webhook', ?, ?, ?, NULL)`,
                [input.id, input.tenantId, input.name, input.url, db.seal(input.signingSecret), yield* now]
              )
              return yield* stored(
                db.one(DestinationRow, "SELECT * FROM gateway_approval_destination WHERE id = ?", [input.id]),
                `approval destination ${input.id}`
              )
            })
          ),

        listApprovalDestinations: (tenantId) =>
          operation(
            "listApprovalDestinations",
            db.all(
              DestinationRow,
              "SELECT * FROM gateway_approval_destination WHERE tenant_id = ? AND deleted_at IS NULL ORDER BY name",
              [tenantId]
            )
          ),

        deleteApprovalDestination: (tenantId, id) =>
          operation(
            "deleteApprovalDestination",
            Effect.gen(function* () {
              yield* db.run(
                "UPDATE gateway_approval_destination SET deleted_at = ? WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL",
                [yield* now, tenantId, id]
              )
            })
          ),

        listProfileApprovalDestinationIds: (profileId) =>
          operation("listProfileApprovalDestinationIds", profileDestinationIds(profileId)),

        replaceProfileApprovalDestinations: (tenantId, profileId, ids) =>
          operation(
            "replaceProfileApprovalDestinations",
            Effect.gen(function* () {
              yield* db.batch([
                { sql: "DELETE FROM gateway_profile_approval_destination WHERE profile_id = ?", args: [profileId] },
                ...ids.map((id) => ({
                  sql: `INSERT INTO gateway_profile_approval_destination (profile_id, destination_id)
                    SELECT ?, id FROM gateway_approval_destination WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL`,
                  args: [profileId, tenantId, id]
                }))
              ])
              return yield* profileDestinationIds(profileId)
            })
          ),

        listApprovalDeliveries: (tenantId, status) =>
          operation(
            "listApprovalDeliveries",
            db.all(
              DeliveryAttemptRow,
              `SELECT delivery.*, destination.name AS destination_name
             FROM gateway_approval_delivery AS delivery
             JOIN gateway_approval_destination AS destination ON destination.id = delivery.destination_id
             JOIN gateway_pending_approval AS approval ON approval.id = delivery.approval_id
            WHERE approval.tenant_id = ? AND (? IS NULL OR approval.status = ?) ORDER BY destination.name`,
              [tenantId, status ?? null, status ?? null]
            )
          ),

        claimDueApprovalDeliveries: (at, limit) =>
          operation(
            "claimDueApprovalDeliveries",
            Effect.gen(function* () {
              const claimed = yield* db.all(
                ClaimedRow,
                `UPDATE gateway_approval_delivery
                SET next_attempt_at = ?
              WHERE id IN (
                SELECT delivery.id FROM gateway_approval_delivery AS delivery
                JOIN gateway_pending_approval AS approval ON approval.id = delivery.approval_id
                WHERE delivery.status IN ('pending', 'retrying') AND delivery.next_attempt_at <= ?
                  AND EXISTS (SELECT 1 FROM gateway_pending_approval AS member
                               WHERE (member.group_id = approval.group_id OR member.id = approval.id)
                                 AND member.status = 'pending' AND member.expires_at > ?)
                ORDER BY delivery.next_attempt_at LIMIT ?
              ) AND next_attempt_at <= ?
              RETURNING id`,
                [millis(at) + claimLease, millis(at), millis(at), limit, millis(at)]
              )
              const ids = claimed.map((row) => row.id)
              if (ids.length === 0) return []
              const rows = yield* db.all(
                DeliveryJobRow,
                // A group's delivery names its oldest call that still waits: the
                // first one, unless a reviewer or a human already decided it. A
                // group decided since the claim has nothing left to announce.
                `SELECT delivery.*, destination.name AS destination_name, destination.url,
                    destination.signing_secret, approval.id AS waiting_id, approval.tenant_id, approval.group_id,
                    approval.profile_id, profile.name AS profile_name, approval.alias, approval.tool, approval.expires_at
               FROM gateway_approval_delivery AS delivery
               JOIN gateway_approval_destination AS destination ON destination.id = delivery.destination_id
               JOIN gateway_pending_approval AS approval ON approval.group_id = delivery.approval_id
               JOIN gateway_profile AS profile ON profile.id = approval.profile_id
              WHERE delivery.id IN (${placeholders(ids)})
                AND approval.id = (
                  SELECT member.id FROM gateway_pending_approval AS member
                   WHERE member.group_id = delivery.approval_id AND member.status = 'pending' AND member.expires_at > ?
                   ORDER BY member.created_at LIMIT 1
                )`,
                [...ids, millis(at)]
              )
              return rows.map(({ waitingId, signingSecret, ...row }): ApprovalDeliveryJob => ({
                ...row,
                approvalId: waitingId,
                signingSecret: db.encryption.open(signingSecret)
              }))
            })
          ),

        settleApprovalDelivery: (input) =>
          operation("settleApprovalDelivery", settle("gateway_approval_delivery", input)),

        claimDueApprovalDecisionDeliveries: (at, limit) =>
          operation(
            "claimDueApprovalDecisionDeliveries",
            Effect.gen(function* () {
              const claimed = yield* db.all(
                ClaimedRow,
                `UPDATE gateway_approval_decision_delivery
                SET next_attempt_at = ?
              WHERE id IN (
                SELECT id FROM gateway_approval_decision_delivery
                 WHERE status IN ('pending', 'retrying') AND next_attempt_at <= ?
                 ORDER BY next_attempt_at LIMIT ?
              ) AND next_attempt_at <= ?
              RETURNING id`,
                [millis(at) + claimLease, millis(at), limit, millis(at)]
              )
              const ids = claimed.map((row) => row.id)
              if (ids.length === 0) return []
              const rows = yield* db.all(
                DecisionDeliveryRow,
                `SELECT delivery.id, delivery.approval_id, delivery.attempts, delivery.created_at,
                    destination.url, destination.signing_secret, approval.tenant_id, approval.group_id,
                    approval.profile_id, profile.name AS profile_name, approval.alias, approval.tool,
                    approval.status, approval.error, approval.decided_by, approval.decided_at
               FROM gateway_approval_decision_delivery AS delivery
               JOIN gateway_approval_destination AS destination ON destination.id = delivery.destination_id
               JOIN gateway_pending_approval AS approval ON approval.id = delivery.approval_id
               JOIN gateway_profile AS profile ON profile.id = approval.profile_id
              WHERE delivery.id IN (${placeholders(ids)})`,
                ids
              )
              return rows.flatMap(({ status, error, groupId, signingSecret, ...row }) =>
                status === "approved" || status === "denied" || status === "expired"
                  ? [
                      {
                        ...row,
                        status,
                        failed: error !== null,
                        groupId: groupId ?? row.approvalId,
                        signingSecret: db.encryption.open(signingSecret)
                      }
                    ]
                  : []
              )
            })
          ),

        settleApprovalDecisionDelivery: (input) =>
          operation("settleApprovalDecisionDelivery", settle("gateway_approval_decision_delivery", input))
      }
    })
  )
}
