import { Effect } from "effect"
import type { InvocationOutcome } from "@integragents/contracts"
import type { ApprovalId, PendingApproval, ProfileId, TenantId } from "../domain.ts"
import type { GatewayStore, SettledApproval } from "../store/index.ts"

/** What a decided call came to: its result, its failure, or why it never ran. */
export type ApprovalOutcome = Extract<InvocationOutcome, { readonly status: "succeeded" | "failed" | "denied" }>

/** The outcome a decided call hands its caller; nothing while it still waits or runs. */
export const approvalOutcome = (approval: PendingApproval): ApprovalOutcome | undefined => {
  switch (approval.status) {
    case "approved":
      return approval.error === null
        ? { status: "succeeded", result: approval.result }
        : { status: "failed", message: approval.error }
    case "denied":
      return {
        status: "denied",
        reason:
          `approval ${approval.id} was denied` +
          (approval.decidedBy === null ? "" : ` by ${approval.decidedBy}`) +
          (approval.error === null ? "" : `: ${approval.error}`)
      }
    case "expired":
      return { status: "denied", reason: `approval ${approval.id} expired before a decision was recorded` }
    case "pending":
    case "executing":
      return undefined
  }
}

/** A call that stopped waiting: approved and run, denied, or expired. */
export interface ApprovalDecided {
  readonly tenantId: TenantId
  readonly approvalId: ApprovalId
  readonly profileId: ProfileId
  readonly status: "approved" | "denied" | "expired"
  readonly decidedBy: string | null
  readonly outcome: ApprovalOutcome
  readonly approval: PendingApproval
}

/**
 * Told once a call is decided, whichever way it was decided: in the
 * dashboard, over the API, in an MCP client, by a reviewer, by expiry, by a
 * revoked profile, or by an interrupted execution being settled. It runs after
 * the decision is stored; a failure is logged and never undoes the decision.
 * A process that stops between the two misses the call, so a host that must
 * not miss one also reads `listApprovals` when it starts.
 */
export type OnApprovalDecided = (decided: ApprovalDecided) => Effect.Effect<void>

const decidedOf = (settled: SettledApproval): ApprovalDecided | undefined => {
  const { tenantId, approval } = settled
  const outcome = approvalOutcome(approval)
  if (outcome === undefined || approval.status === "pending" || approval.status === "executing") return undefined
  return {
    tenantId,
    approvalId: approval.id,
    profileId: approval.profileId,
    status: approval.status,
    decidedBy: approval.decidedBy,
    outcome,
    approval
  }
}

/** Every path that decides a call goes through one of these store members, so wrapping them tells the hook of all. */
export const notifyingDecisions = (store: GatewayStore, onApprovalDecided: OnApprovalDecided): GatewayStore => {
  const tell = (settled: ReadonlyArray<SettledApproval>) =>
    Effect.forEach(
      settled,
      (entry) => {
        const decided = decidedOf(entry)
        return decided === undefined
          ? Effect.void
          : onApprovalDecided(decided).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("onApprovalDecided failed", cause).pipe(
                  Effect.annotateLogs({ "approval.id": decided.approvalId })
                )
              )
            )
      },
      { discard: true }
    )
  return {
    ...store,
    settleApproval: (input) =>
      Effect.tap(store.settleApproval(input), (settled) =>
        settled
          ? Effect.flatMap(store.getApproval(input.tenantId, input.id), (approval) =>
              approval === undefined ? Effect.void : tell([{ tenantId: input.tenantId, approval }])
            )
          : Effect.void
      ),
    expireApprovals: (now) => Effect.tap(store.expireApprovals(now), tell),
    settleInterruptedApprovals: (claimedBefore, error) =>
      Effect.tap(store.settleInterruptedApprovals(claimedBefore, error), tell),
    cancelApprovalsForProfile: (profileId) => Effect.tap(store.cancelApprovalsForProfile(profileId), tell)
  }
}
