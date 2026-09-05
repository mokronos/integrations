import { Clock, Effect, Schema } from "effect"
import type { IntegrationsApi } from "@mokronos/integrations"
import {
  aliasForConnection,
  ApprovalId,
  connectionSubject,
  sameConnectionRef,
  TenantId
} from "./domain.ts"
import { executeAuthorized } from "./invoke.ts"
import type { GatewayStore } from "./store.ts"

export class ApprovalNotFound extends Schema.TaggedError<ApprovalNotFound>()("ApprovalNotFound", {
  id: ApprovalId
}) {}

export class ApprovalConflict extends Schema.TaggedError<ApprovalConflict>()("ApprovalConflict", {
  message: Schema.String
}) {}

const ApprovalDecision = Schema.Struct({
  tenantId: TenantId,
  id: ApprovalId,
  decidedBy: Schema.NullOr(Schema.String)
})

const pendingApproval = Effect.fn("Approvals.pending")(function*(store: GatewayStore, input: typeof ApprovalDecision.Type) {
  const { tenantId, id } = input
  const approval = yield* store.getApproval(tenantId, id)
  if (approval === undefined) return yield* new ApprovalNotFound({ id })
  if (approval.status !== "pending") {
    return yield* new ApprovalConflict({ message: `Approval ${id} is already ${approval.status}` })
  }
  const now = yield* Clock.currentTimeMillis
  if (approval.expiresAt.getTime() <= now) {
    yield* store.settleApproval({ tenantId, id, status: "expired", decidedBy: null, result: null, error: "expired before a decision was recorded" })
    return yield* new ApprovalConflict({ message: `Approval ${id} expired` })
  }
  return approval
})

export const denyApproval = Effect.fn("Approvals.deny")(function*(store: GatewayStore, input: typeof ApprovalDecision.Type) {
  yield* pendingApproval(store, input)
  const settled = yield* store.settleApproval({ ...input, status: "denied", result: null, error: null })
  if (!settled) return yield* new ApprovalConflict({ message: `Approval ${input.id} has already been decided` })
  const approval = yield* store.getApproval(input.tenantId, input.id)
  if (approval === undefined) return yield* new ApprovalNotFound({ id: input.id })
  return { approval }
})

export const approveApproval = Effect.fn("Approvals.approve")(function*(
  dependencies: {
    readonly store: GatewayStore
    readonly integrations: Pick<IntegrationsApi, "tools">
    readonly retentionDays: number
  },
  input: typeof ApprovalDecision.Type
) {
  const { store } = dependencies
  const { tenantId, id, decidedBy } = input
  const approval = yield* pendingApproval(store, input)
  const [client, accessProfile, approvalPolicy] = yield* Effect.all([
    store.findClientById(tenantId, approval.clientId),
    store.findAccessProfile(tenantId, approval.accessProfileId),
    store.findApprovalPolicy(tenantId, approval.approvalPolicyId)
  ])
  const accessTools = accessProfile === undefined ? [] : yield* store.listAccessProfileTools(accessProfile.id)
  const approvalTools = approvalPolicy === undefined ? [] : yield* store.listApprovalPolicyTools(approvalPolicy.id)
  const accessProfileTool = accessTools.find((candidate) =>
    candidate.tool === approval.tool && aliasForConnection(candidate.connection) === approval.alias)
  const approvalPolicyTool = accessProfileTool === undefined ? undefined : approvalTools.find((candidate) =>
    candidate.tool === approval.tool && sameConnectionRef(candidate.connection, accessProfileTool.connection))
  if (client === undefined || client.revokedAt !== null
    || client.accessProfileId !== approval.accessProfileId
    || client.approvalPolicyId !== approval.approvalPolicyId
    || accessProfile === undefined || approvalPolicy === undefined
    || accessProfileTool === undefined || approvalPolicyTool === undefined) {
    yield* store.settleApproval({ tenantId, id, status: "denied", decidedBy, result: null, error: "the client assignments or tool intersection changed while this call was frozen" })
    return yield* new ApprovalConflict({ message: `Approval ${id} is no longer authorized` })
  }

  // A durable claim precedes the external side effect. A lost process leaves
  // it executing; neither a retry nor expiry may execute or deny it again.
  return yield* Effect.gen(function*() {
    const claimed = yield* store.claimApproval({ tenantId, id, decidedBy })
    if (!claimed) return yield* new ApprovalConflict({ message: `Approval ${id} was decided or expired` })
    const outcome = yield* executeAuthorized(dependencies, {
      status: "authorized",
      client,
      accessProfile,
      accessProfileTool,
      approvalPolicy,
      approvalPolicyTool,
      alias: approval.alias,
      connection: accessProfileTool.connection,
      subject: connectionSubject(accessProfileTool.connection) ?? null,
      decision: approvalPolicyTool.decision
    }, approval.arguments)
    yield* store.settleApproval({
      tenantId, id, status: "approved", decidedBy,
      result: outcome.status === "succeeded" ? outcome.result : null,
      error: outcome.status === "failed" ? outcome.message : null
    })
    const settled = yield* store.getApproval(tenantId, id)
    if (settled === undefined) return yield* new ApprovalNotFound({ id })
    return { approval: settled, outcome }
  }).pipe(Effect.uninterruptible)
})
