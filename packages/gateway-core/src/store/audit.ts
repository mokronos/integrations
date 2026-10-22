import { Context, Effect, Layer, Schema } from "effect"
import type { NonNegativeInt, PositiveInt } from "@integragents/contracts"
import { AuditApproval, AuditId, AuditOutcome, ProfileId, SubjectId, ToolDecision, ToolName } from "../domain.ts"
import type { Alias, AuditRecord, Caller, ConnectionRef, TenantId } from "../domain.ts"
import {
  CallerColumns,
  callerArgs,
  callerOf,
  ConnectionColumns,
  connectionArgs,
  connectionOf,
  millis,
  Millis
} from "./columns.ts"
import { now, operation, StoreSql } from "./sql.ts"
import type { GatewayStoreError, SqlValue } from "./sql.ts"

export interface AuditQuery {
  readonly limit?: PositiveInt
  readonly offset?: NonNegativeInt
  readonly profileId?: ProfileId
  readonly alias?: Alias
  readonly tool?: ToolName
  readonly outcome?: AuditOutcome
  readonly since?: Date
}

export interface RecordAuditInput {
  readonly tenantId: TenantId
  readonly id: AuditId
  readonly profileId: ProfileId | null
  readonly caller: Caller
  readonly authorizedBySubjectId: SubjectId | null
  readonly alias: Alias | null
  readonly tool: ToolName | null
  readonly connection: ConnectionRef | null
  readonly decision: ToolDecision | null
  readonly approval?: AuditApproval
  readonly outcome: AuditOutcome
  readonly message: string | null
  readonly arguments?: {
    readonly value: typeof Schema.Json.Type
    readonly expiresAt: Date
  }
}

/** What every call came to, and the arguments it was made with for as long as they are kept. */
export interface AuditStore {
  recordAudit(input: RecordAuditInput): Effect.Effect<void, GatewayStoreError>
  listAudit(tenantId: TenantId, options: AuditQuery): Effect.Effect<ReadonlyArray<AuditRecord>, GatewayStoreError>
  countAudit(
    tenantId: TenantId,
    options: Omit<AuditQuery, "limit" | "offset">
  ): Effect.Effect<number, GatewayStoreError>
  expireAuditArguments(now: Date): Effect.Effect<number, GatewayStoreError>
}

export const AuditRow = Schema.Struct({
  id: AuditId,
  profile_id: Schema.NullOr(ProfileId),
  ...CallerColumns,
  authorized_by_subject_id: Schema.NullOr(SubjectId),
  alias: Schema.NullOr(Schema.String),
  tool: Schema.NullOr(ToolName),
  owner: Schema.NullOr(ConnectionColumns.owner),
  subject: ConnectionColumns.subject,
  integration: Schema.NullOr(ConnectionColumns.integration),
  connection_name: Schema.NullOr(ConnectionColumns.connection_name),
  decision: Schema.NullOr(ToolDecision),
  approval: Schema.NullOr(AuditApproval),
  outcome: AuditOutcome,
  message: Schema.NullOr(Schema.String),
  created_at: Millis
})

export const auditRecordOf = (row: typeof AuditRow.Type): AuditRecord => {
  const { owner, integration, connection_name } = row
  return {
    id: row.id,
    profileId: row.profile_id,
    caller: callerOf(row),
    authorizedBySubjectId: row.authorized_by_subject_id,
    alias: row.alias,
    tool: row.tool,
    connection:
      owner === null || integration === null || connection_name === null
        ? null
        : connectionOf({ owner, subject: row.subject, integration, connection_name }),
    subject: row.subject,
    decision: row.decision,
    approval: row.approval,
    outcome: row.outcome,
    message: row.message,
    createdAt: row.created_at
  }
}

const auditFilter = (options: Omit<AuditQuery, "limit" | "offset">) => {
  const clauses: Array<string> = []
  const args: Array<SqlValue> = []
  const where = (clause: string, value: SqlValue | undefined) => {
    if (value === undefined) return
    clauses.push(clause)
    args.push(value)
  }
  where("profile_id = ?", options.profileId)
  where("alias = ?", options.alias)
  where("tool = ?", options.tool)
  where("outcome = ?", options.outcome)
  where("created_at >= ?", options.since === undefined ? undefined : millis(options.since))
  return { where: clauses.map((clause) => ` AND ${clause}`).join(""), args }
}

export class AuditStoreService extends Context.Service<AuditStoreService, AuditStore>()(
  "@integragents/gateway-core/AuditStore"
) {
  static readonly layer = Layer.effect(
    AuditStoreService,
    Effect.map(StoreSql, (db): AuditStore => ({
      recordAudit: (input) =>
        operation(
          "recordAudit",
          Effect.gen(function* () {
            const connection = input.connection
            yield* db.run(
              `INSERT INTO gateway_audit
             (id, tenant_id, profile_id, api_key_id, oauth_grant_id, oauth_application_id, credential_name, agent,
              authorized_by_subject_id, alias, tool, owner, subject, integration, connection_name, decision, approval,
              outcome, message, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                input.id,
                input.tenantId,
                input.profileId,
                ...callerArgs(input.caller),
                input.authorizedBySubjectId,
                input.alias,
                input.tool,
                ...(connection === null ? [null, null, null, null] : connectionArgs(connection)),
                input.decision,
                input.approval ?? null,
                input.outcome,
                input.message,
                yield* now
              ]
            )
            if (input.arguments !== undefined) {
              yield* db.run("INSERT INTO gateway_audit_arguments (audit_id, arguments, expires_at) VALUES (?, ?, ?)", [
                input.id,
                db.seal(JSON.stringify(input.arguments.value)),
                millis(input.arguments.expiresAt)
              ])
            }
          })
        ),

      listAudit: (tenantId, options) =>
        operation(
          "listAudit",
          Effect.gen(function* () {
            const filter = auditFilter(options)
            const rows = yield* db.all(
              AuditRow,
              `SELECT * FROM gateway_audit WHERE tenant_id = ?${filter.where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
              [tenantId, ...filter.args, options.limit ?? 50, options.offset ?? 0]
            )
            return rows.map(auditRecordOf)
          })
        ),

      countAudit: (tenantId, options) =>
        operation(
          "countAudit",
          Effect.gen(function* () {
            const filter = auditFilter(options)
            return yield* db.count(`SELECT COUNT(*) AS total FROM gateway_audit WHERE tenant_id = ?${filter.where}`, [
              tenantId,
              ...filter.args
            ])
          })
        ),

      expireAuditArguments: (at) =>
        operation(
          "expireAuditArguments",
          db.changed("DELETE FROM gateway_audit_arguments WHERE expires_at <= ? RETURNING audit_id", [millis(at)])
        )
    }))
  )
}
