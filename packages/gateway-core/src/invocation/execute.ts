import { relayableInput, unrelayableInputMessage } from "@integragents/integrations"
import type { Integrations, StorageError, ToolCallContext } from "@integragents/integrations"
import { toGatewayError } from "../errors.ts"
import { connectionOwner, ToolAddress, whenPresent, whenTrue } from "@integragents/contracts"
import type { IdempotencyKey, InputAnswer, InvocationOutcome, Json } from "@integragents/contracts"
import { Crypto, DateTime, Duration, Effect } from "effect"
import type { ApprovalId, AuditApproval, Authorization, CallOrigin, ConnectionRef, ToolName } from "../domain.ts"
import { sealRound } from "./input-rounds.ts"
import type { RoundApproval } from "./input-rounds.ts"
import { newAuditId } from "../keys.ts"
import type { AuditStore, GatewayStoreError, RecordAuditInput, SealedStateStore } from "../store/index.ts"

export const boundToolAddress = (connection: ConnectionRef, tool: ToolName): ToolAddress =>
  ToolAddress.make(`tools.${connection.integration}.${connectionOwner(connection)}.${connection.name}.${tool}`)

export const auditFor = (
  authorization: Extract<Authorization, { status: "authorized" }>,
  outcome: RecordAuditInput["outcome"],
  message: string | null,
  argumentsValue: Json,
  retentionDays: number,
  origin: CallOrigin,
  approval?: AuditApproval
): Effect.Effect<RecordAuditInput, never, Crypto.Crypto> =>
  Effect.all([newAuditId, DateTime.now]).pipe(
    Effect.map(([id, at]): RecordAuditInput => ({
      tenantId: authorization.profile.tenantId,
      id,
      profileId: authorization.profile.id,
      caller: origin.caller,
      authorizedBySubjectId: origin.authorizedBy,
      alias: authorization.alias,
      tool: authorization.profileTool.tool,
      connection: authorization.connection,
      decision: authorization.decision,
      ...whenPresent("approval", approval),
      outcome,
      message,
      arguments: {
        value: argumentsValue,
        expiresAt: DateTime.toDateUtc(DateTime.addDuration(at, Duration.days(retentionDays)))
      }
    }))
  )

/** Recorded for a call whose caller went away while it ran: the upstream may or may not have acted on it. */
const cancelledByCaller = "cancelled by the caller while it ran; the tool may have acted on it"

/** How a call came to run, and the round it continues. */
export interface ExecutionRound {
  /** How the call that asked got its approval; nothing for a call that runs directly. */
  readonly approved?: RoundApproval
  /** The approval it ran under, which a host tool is told about. */
  readonly approvalId?: ApprovalId
  /** The caller's key for the call, which a host tool is told about. */
  readonly idempotencyKey?: IdempotencyKey
  /** Whether a round of input the tool asks for goes back to the caller. */
  readonly relay?: boolean
  readonly upstream?: InputAnswer
}

export const executeAuthorized = Effect.fn("Invocation.executeAuthorized")(function* (
  dependencies: {
    readonly store: AuditStore & SealedStateStore
    readonly integrations: Integrations["Service"]
    readonly retentionDays: number
  },
  authorization: Extract<Authorization, { status: "authorized" }>,
  argumentsValue: Json,
  origin: CallOrigin,
  round: ExecutionRound = {}
): Effect.fn.Return<
  Extract<InvocationOutcome, { status: "succeeded" | "failed" | "input-required" }>,
  GatewayStoreError | StorageError,
  Crypto.Crypto
> {
  const address = boundToolAddress(authorization.connection, authorization.profileTool.tool)
  const approved = round.approved
  const record = (outcome: "succeeded" | "failed", message: string | null) =>
    Effect.flatMap(
      auditFor(authorization, outcome, message, argumentsValue, dependencies.retentionDays, origin, approved?.approval),
      dependencies.store.recordAudit
    )
  const context: ToolCallContext = {
    tenantId: authorization.profile.tenantId,
    profileId: authorization.profile.id,
    ...whenPresent("subject", authorization.subject),
    ...whenPresent("approvalId", round.approvalId),
    ...whenPresent("idempotencyKey", round.idempotencyKey)
  }
  const invocation = yield* Effect.result(
    dependencies.integrations
      .execute(address, argumentsValue, round.upstream, context)
      .pipe(Effect.onInterrupt(() => Effect.ignore(record("failed", cancelledByCaller))))
  )
  if (invocation._tag === "Failure") {
    const failure = invocation.failure
    if (failure._tag === "StorageError") return yield* failure
    const error = toGatewayError(failure, authorization.profileTool.tool)
    yield* record("failed", error.message)
    return { status: "failed", message: error.message, error }
  }
  const execution = invocation.success
  if (execution.kind === "complete") {
    yield* record("succeeded", approved?.message ?? null)
    return {
      status: "succeeded",
      result: execution.result,
      ...whenTrue(execution.attachments.length > 0, () => ({ attachments: execution.attachments }))
    }
  }
  const { inputRequests, requestState } = execution.round
  if (round.relay !== true || !relayableInput(inputRequests)) {
    const message = unrelayableInputMessage(inputRequests)
    yield* record("failed", message)
    return { status: "failed", message }
  }
  return {
    status: "input-required",
    inputRequests,
    requestState: yield* sealRound(
      dependencies.store,
      { profileId: authorization.profile.id, tool: address, arguments: argumentsValue },
      { approval: approved ?? null, upstream: requestState }
    )
  }
})
