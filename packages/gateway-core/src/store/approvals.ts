import { Context, Effect, Layer, Schema } from "effect"
import { Attachment } from "@integragents/contracts"
import {
  ApprovalId,
  ApprovalRuleId,
  ApprovalStatus,
  ArgumentPattern,
  IdempotencyKey,
  ProfileId,
  SubjectId,
  TenantId,
  ToolName,
  canonicalJson
} from "../domain.ts"
import type {
  Alias,
  ApprovalGroupWindowMinutes,
  ApprovalRule,
  Caller,
  ConnectionRef,
  PendingApproval
} from "../domain.ts"
import {
  CallerColumns,
  callerArgs,
  callerOf,
  ConnectionColumns,
  connectionArgs,
  connectionOf,
  Expiry,
  expiryMillis,
  millis,
  Millis,
  NullableMillis
} from "./columns.ts"
import { now, operation, placeholders, stored, StoreSql } from "./sql.ts"
import type { GatewayStoreError, SqlValue } from "./sql.ts"

export interface CreateApprovalInput {
  readonly tenantId: TenantId
  readonly id: ApprovalId
  readonly profileId: ProfileId
  readonly caller: Caller
  readonly alias: Alias
  readonly tool: ToolName
  /** Who the call acts for; nobody when absent. */
  readonly subject?: SubjectId | null
  /** A keyed call gets its own approval, never one an identical call already waits on. */
  readonly idempotencyKey?: IdempotencyKey
  readonly arguments: typeof Schema.Json.Type
  /** Null waits until someone decides. */
  readonly expiresAt: Date | null
  /** Joins the newest open group for this tool whose first call is younger than this. */
  readonly groupWindowMinutes: ApprovalGroupWindowMinutes
}

/** A call that just reached a decision, with the tenant it belongs to. */
export interface SettledApproval {
  readonly tenantId: TenantId
  readonly approval: PendingApproval
}

/** Calls that wait for a human, and the patterns a profile saved to stop asking. */
export interface ApprovalStore {
  createApprovalRule(input: {
    readonly id: ApprovalRuleId
    readonly profileId: ProfileId
    readonly connection: ConnectionRef
    readonly tool: ToolName
    readonly pattern: ArgumentPattern
    readonly createdBy: string | null
  }): Effect.Effect<ApprovalRule, GatewayStoreError>
  listApprovalRules(profileId: ProfileId): Effect.Effect<ReadonlyArray<ApprovalRule>, GatewayStoreError>
  findApprovalRule(id: ApprovalRuleId): Effect.Effect<ApprovalRule | undefined, GatewayStoreError>
  updateApprovalRule(id: ApprovalRuleId, pattern: ArgumentPattern): Effect.Effect<ApprovalRule, GatewayStoreError>
  deleteApprovalRule(id: ApprovalRuleId): Effect.Effect<void, GatewayStoreError>

  createApproval(input: CreateApprovalInput): Effect.Effect<PendingApproval, GatewayStoreError>
  getApproval(tenantId: TenantId, id: ApprovalId): Effect.Effect<PendingApproval | undefined, GatewayStoreError>
  listApprovals(
    tenantId: TenantId,
    status?: ApprovalStatus
  ): Effect.Effect<ReadonlyArray<PendingApproval>, GatewayStoreError>
  findUncollectedApproval(
    input: Pick<CreateApprovalInput, "tenantId" | "profileId" | "alias" | "tool" | "subject" | "arguments">
  ): Effect.Effect<PendingApproval | undefined, GatewayStoreError>
  collectApproval(tenantId: TenantId, id: ApprovalId): Effect.Effect<boolean, GatewayStoreError>
  claimApproval(input: {
    readonly tenantId: TenantId
    readonly id: ApprovalId
    readonly decidedBy: string | null
    /** What runs instead of the frozen arguments, kept next to them. */
    readonly editedArguments?: typeof Schema.Json.Type
  }): Effect.Effect<boolean, GatewayStoreError>
  settleApproval(input: {
    readonly tenantId: TenantId
    readonly id: ApprovalId
    readonly status: "approved" | "denied" | "expired"
    readonly decidedBy: string | null
    readonly result: typeof Schema.Json.Type | null
    readonly attachments?: ReadonlyArray<Attachment>
    readonly error: string | null
  }): Effect.Effect<boolean, GatewayStoreError>
  /**
   * Settles every execution claimed at or before `claimedBefore` that never
   * recorded an outcome: approved, with an error saying the outcome is
   * unknown. Nothing runs again.
   */
  settleInterruptedApprovals(
    claimedBefore: Date,
    error: string
  ): Effect.Effect<ReadonlyArray<SettledApproval>, GatewayStoreError>
  /** Denies what a revoked profile left waiting, and answers what it denied. */
  cancelApprovalsForProfile(profileId: ProfileId): Effect.Effect<ReadonlyArray<SettledApproval>, GatewayStoreError>
  /** Expires every call still waiting at `now`, and answers what it expired. */
  expireApprovals(now: Date): Effect.Effect<ReadonlyArray<SettledApproval>, GatewayStoreError>
}

export const ApprovalRow = Schema.Struct({
  id: ApprovalId,
  tenant_id: TenantId,
  group_id: Schema.NullOr(ApprovalId),
  profile_id: ProfileId,
  ...CallerColumns,
  alias: Schema.String,
  tool: ToolName,
  subject: Schema.NullOr(SubjectId),
  arguments: Schema.String,
  edited_arguments: Schema.NullOr(Schema.String),
  idempotency_key: Schema.NullOr(IdempotencyKey),
  status: ApprovalStatus,
  created_at: Millis,
  expires_at: Expiry,
  decided_at: NullableMillis,
  decided_by: Schema.NullOr(Schema.String),
  result: Schema.NullOr(Schema.String),
  attachments: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  collected_at: NullableMillis
})
type ApprovalRow = typeof ApprovalRow.Type

const ApprovalRuleRow = Schema.Struct({
  id: ApprovalRuleId,
  profile_id: ProfileId,
  ...ConnectionColumns,
  tool: ToolName,
  pattern: Schema.String,
  created_at: Millis,
  created_by: Schema.NullOr(Schema.String)
})

/** Reads an approval row back, opening the columns it was sealed in with `open`. */
export const approvalOf = (row: ApprovalRow, open: (sealed: string) => string) =>
  Effect.gen(function* () {
    const json = (sealed: string) => Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(open(sealed))
    const approval: PendingApproval = {
      id: row.id,
      groupId: row.group_id ?? row.id,
      profileId: row.profile_id,
      caller: callerOf(row),
      alias: row.alias,
      tool: row.tool,
      subject: row.subject,
      arguments: yield* json(row.arguments),
      editedArguments: row.edited_arguments === null ? null : yield* json(row.edited_arguments),
      idempotencyKey: row.idempotency_key,
      status: row.status,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      decidedAt: row.decided_at,
      decidedBy: row.decided_by,
      result: row.result === null ? null : yield* json(row.result),
      attachments:
        row.attachments === null
          ? []
          : yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Attachment)))(open(row.attachments)),
      error: row.error,
      collectedAt: row.collected_at
    }
    return approval
  })

export class ApprovalStoreService extends Context.Service<ApprovalStoreService, ApprovalStore>()(
  "@integragents/gateway-core/ApprovalStore"
) {
  static readonly layer = Layer.effect(
    ApprovalStoreService,
    Effect.gen(function* () {
      const db = yield* StoreSql
      const open = (row: ApprovalRow) => approvalOf(row, db.encryption.open)

      const approvals = (query: string, args: ReadonlyArray<SqlValue>) =>
        Effect.flatMap(db.all(ApprovalRow, query, args), (rows) => Effect.forEach(rows, open))

      const approval = (query: string, args: ReadonlyArray<SqlValue>) =>
        Effect.flatMap(db.one(ApprovalRow, query, args), (row) => (row === undefined ? Effect.undefined : open(row)))

      const rules = (query: string, args: ReadonlyArray<SqlValue>) =>
        Effect.flatMap(db.all(ApprovalRuleRow, query, args), (rows) =>
          Effect.forEach(rows, (row) =>
            Effect.map(db.openJson(ArgumentPattern, row.pattern), (pattern): ApprovalRule => ({
              id: row.id,
              profileId: row.profile_id,
              connection: connectionOf(row),
              tool: row.tool,
              pinned: pattern.pinned,
              free: pattern.free,
              createdAt: row.created_at,
              createdBy: row.created_by
            }))
          )
        )

      const rule = (id: ApprovalRuleId) =>
        Effect.map(rules("SELECT * FROM gateway_approval_rule WHERE id = ?", [id]), (found) => found[0])

      const approvalMatch = (input: Parameters<ApprovalStore["findUncollectedApproval"]>[0]) => {
        const canonical = canonicalJson(input.arguments)
        return {
          sql: `tenant_id = ? AND profile_id = ? AND alias = ? AND tool = ? AND subject IS ? AND idempotency_key IS NULL
        AND ((arguments_lookup IS NOT NULL AND arguments_lookup = ?)
          OR (arguments_lookup IS NULL AND arguments = ?)) AND collected_at IS NULL`,
          args: [
            input.tenantId,
            input.profileId,
            input.alias,
            input.tool,
            input.subject ?? null,
            db.encryption.lookup(canonical),
            canonical
          ]
        }
      }

      const findUncollectedApproval = (input: Parameters<ApprovalStore["findUncollectedApproval"]>[0]) => {
        const match = approvalMatch(input)
        return approval(
          `SELECT * FROM gateway_pending_approval WHERE ${match.sql} ORDER BY created_at DESC LIMIT 1`,
          match.args
        )
      }

      /** Queues an `approval.decided` notification to each destination of each decided call's profile. */
      const queueDecisionDeliveries = (ids: ReadonlyArray<ApprovalId>, at: number) =>
        ids.length === 0
          ? Effect.void
          : db.run(
              `INSERT INTO gateway_approval_decision_delivery
             (id, approval_id, destination_id, status, attempts, next_attempt_at, delivered_at, last_error, created_at)
           SELECT lower(hex(randomblob(16))), approval.id, assignment.destination_id, 'pending', 0, ?, NULL, NULL, ?
             FROM gateway_pending_approval AS approval
             JOIN gateway_profile_approval_destination AS assignment ON assignment.profile_id = approval.profile_id
             JOIN gateway_approval_destination AS destination ON destination.id = assignment.destination_id
            WHERE approval.id IN (${placeholders(ids)}) AND destination.deleted_at IS NULL
              AND approval.status IN ('approved', 'denied', 'expired')
           ON CONFLICT DO NOTHING`,
              [at, at, ...ids]
            )

      /** Rows an UPDATE … RETURNING * settled, with their notifications queued in the same transaction. */
      const settledRows = (query: string, args: ReadonlyArray<SqlValue>) =>
        db.sql.withTransaction(
          Effect.gen(function* () {
            const rows = yield* db.all(ApprovalRow, query, args)
            yield* queueDecisionDeliveries(
              rows.map((row) => row.id),
              yield* now
            )
            return yield* Effect.forEach(rows, (row) =>
              Effect.map(open(row), (approval): SettledApproval => ({ tenantId: row.tenant_id, approval }))
            )
          })
        )

      return {
        createApprovalRule: (input) =>
          operation(
            "createApprovalRule",
            Effect.gen(function* () {
              yield* db.run(
                `INSERT INTO gateway_approval_rule
               (id, profile_id, owner, subject, integration, connection_name, tool, pattern, created_at, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                  input.id,
                  input.profileId,
                  ...connectionArgs(input.connection),
                  input.tool,
                  db.seal(JSON.stringify(input.pattern)),
                  yield* now,
                  input.createdBy
                ]
              )
              return yield* stored(rule(input.id), `approval rule ${input.id}`)
            })
          ),

        listApprovalRules: (profileId) =>
          operation(
            "listApprovalRules",
            rules(
              "SELECT * FROM gateway_approval_rule WHERE profile_id = ? ORDER BY integration, connection_name, tool, created_at",
              [profileId]
            )
          ),

        findApprovalRule: (id) => operation("findApprovalRule", rule(id)),

        updateApprovalRule: (id, pattern) =>
          operation(
            "updateApprovalRule",
            Effect.gen(function* () {
              yield* db.run("UPDATE gateway_approval_rule SET pattern = ? WHERE id = ?", [
                db.seal(JSON.stringify(pattern)),
                id
              ])
              return yield* stored(rule(id), `approval rule ${id}`)
            })
          ),

        deleteApprovalRule: (id) =>
          operation("deleteApprovalRule", db.run("DELETE FROM gateway_approval_rule WHERE id = ?", [id])),

        createApproval: (input) =>
          operation(
            "createApproval",
            Effect.gen(function* () {
              const match = approvalMatch(input)
              const keyed = input.idempotencyKey !== undefined
              const canonical = canonicalJson(input.arguments)
              const createdAt = yield* now
              yield* db.batch([
                {
                  sql: `INSERT INTO gateway_pending_approval
                      (id, tenant_id, profile_id, api_key_id, oauth_grant_id, oauth_application_id, credential_name, agent,
                       alias, tool, subject, idempotency_key, arguments, arguments_lookup, group_id, status, created_at,
                       expires_at, decided_at, decided_by, result, error, collected_at)
                    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE((
                        SELECT member.group_id FROM gateway_pending_approval AS member
                          JOIN gateway_pending_approval AS lead ON lead.id = member.group_id
                         WHERE member.tenant_id = ? AND member.profile_id = ? AND member.alias = ? AND member.tool = ?
                           AND member.status = 'pending' AND member.expires_at > ? AND lead.created_at > ?
                         ORDER BY lead.created_at DESC LIMIT 1
                      ), ?), 'pending', ?, ?, NULL, NULL, NULL, NULL, NULL
                    ${keyed ? "" : `WHERE NOT EXISTS (SELECT 1 FROM gateway_pending_approval WHERE ${match.sql})`}`,
                  args: [
                    input.id,
                    input.tenantId,
                    input.profileId,
                    ...callerArgs(input.caller),
                    input.alias,
                    input.tool,
                    input.subject ?? null,
                    input.idempotencyKey ?? null,
                    db.seal(canonical),
                    db.encryption.lookup(canonical),
                    input.tenantId,
                    input.profileId,
                    input.alias,
                    input.tool,
                    createdAt,
                    createdAt - input.groupWindowMinutes * 60_000,
                    input.id,
                    createdAt,
                    expiryMillis(input.expiresAt),
                    ...(keyed ? [] : match.args)
                  ]
                },
                {
                  sql: `INSERT INTO gateway_approval_delivery
                      (id, approval_id, destination_id, status, attempts, next_attempt_at, delivered_at, last_error)
                    SELECT lower(hex(randomblob(16))), ?, assignment.destination_id, 'pending', 0, ?, NULL, NULL
                      FROM gateway_profile_approval_destination AS assignment
                      JOIN gateway_approval_destination AS destination ON destination.id = assignment.destination_id
                     WHERE assignment.profile_id = ? AND destination.deleted_at IS NULL
                       AND EXISTS (SELECT 1 FROM gateway_pending_approval WHERE id = ? AND group_id = id)`,
                  args: [input.id, createdAt, input.profileId, input.id]
                }
              ])
              return yield* stored(
                keyed
                  ? approval("SELECT * FROM gateway_pending_approval WHERE id = ?", [input.id])
                  : findUncollectedApproval(input),
                `approval ${input.id}`
              )
            })
          ),

        findUncollectedApproval: (input) => operation("findUncollectedApproval", findUncollectedApproval(input)),

        collectApproval: (tenantId, id) =>
          operation(
            "collectApproval",
            Effect.gen(function* () {
              const changed = yield* db.changed(
                `UPDATE gateway_pending_approval
                SET collected_at = ?
              WHERE tenant_id = ? AND id = ? AND collected_at IS NULL
                AND status IN ('approved', 'denied', 'expired')
              RETURNING id`,
                [yield* now, tenantId, id]
              )
              return changed > 0
            })
          ),

        getApproval: (tenantId, id) =>
          operation(
            "getApproval",
            approval("SELECT * FROM gateway_pending_approval WHERE tenant_id = ? AND id = ?", [tenantId, id])
          ),

        listApprovals: (tenantId, status) =>
          operation(
            "listApprovals",
            status === undefined
              ? approvals("SELECT * FROM gateway_pending_approval WHERE tenant_id = ? ORDER BY created_at DESC", [
                  tenantId
                ])
              : approvals(
                  "SELECT * FROM gateway_pending_approval WHERE tenant_id = ? AND status = ? ORDER BY created_at DESC",
                  [tenantId, status]
                )
          ),

        claimApproval: (input) =>
          operation(
            "claimApproval",
            Effect.gen(function* () {
              const at = yield* now
              const changed = yield* db.changed(
                `UPDATE gateway_pending_approval
                SET status = 'executing', decided_at = ?, decided_by = ?, claimed_at = ?, edited_arguments = ?
              WHERE tenant_id = ? AND id = ? AND status = 'pending' AND expires_at > ?
              RETURNING id`,
                [
                  at,
                  input.decidedBy,
                  at,
                  input.editedArguments === undefined ? null : db.seal(canonicalJson(input.editedArguments)),
                  input.tenantId,
                  input.id,
                  at
                ]
              )
              return changed === 1
            })
          ),

        settleApproval: (input) =>
          operation(
            "settleApproval",
            Effect.gen(function* () {
              const settled = yield* settledRows(
                `UPDATE gateway_pending_approval
                SET status = ?, decided_at = ?, decided_by = ?, result = ?, attachments = ?, error = ?
              WHERE tenant_id = ? AND id = ? AND status = ?
              RETURNING *`,
                [
                  input.status,
                  yield* now,
                  input.decidedBy,
                  input.result === null ? null : db.seal(JSON.stringify(input.result)),
                  input.attachments === undefined || input.attachments.length === 0
                    ? null
                    : db.seal(JSON.stringify(input.attachments)),
                  input.error,
                  input.tenantId,
                  input.id,
                  input.status === "approved" ? "executing" : "pending"
                ]
              )
              return settled.length === 1
            })
          ),

        settleInterruptedApprovals: (claimedBefore, error) =>
          operation(
            "settleInterruptedApprovals",
            Effect.gen(function* () {
              // Claims from before claimed_at was kept are dated by decided_at, which the claim set too.
              return yield* settledRows(
                `UPDATE gateway_pending_approval
                SET status = 'approved', decided_at = ?, error = ?
              WHERE status = 'executing' AND COALESCE(claimed_at, decided_at) <= ?
              RETURNING *`,
                [yield* now, error, millis(claimedBefore)]
              )
            })
          ),

        cancelApprovalsForProfile: (profileId) =>
          operation(
            "cancelApprovalsForProfile",
            Effect.gen(function* () {
              return yield* settledRows(
                `UPDATE gateway_pending_approval
                SET status = 'denied', decided_at = ?, decided_by = 'profile-revoked'
              WHERE profile_id = ? AND status = 'pending'
              RETURNING *`,
                [yield* now, profileId]
              )
            })
          ),

        expireApprovals: (at) =>
          operation(
            "expireApprovals",
            Effect.gen(function* () {
              return yield* settledRows(
                `UPDATE gateway_pending_approval
                SET status = 'expired', decided_at = ?, error = 'expired before a decision was recorded'
              WHERE status = 'pending' AND expires_at <= ?
              RETURNING *`,
                [yield* now, millis(at)]
              )
            })
          )
      }
    })
  )
}
