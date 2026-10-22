import { Context, type Duration, Effect, Schema } from "effect"
import type { Json } from "@integragents/contracts"
import type { Alias, ConnectionRef, PendingApproval, Profile, TenantId, ToolName } from "./domain.ts"

/**
 * What a reviewer makes of a call that asks: run it now, refuse it, or leave
 * it to a human. The reason lands in the audit trail.
 */
export const ReviewVerdict = Schema.Union([
  Schema.Struct({ verdict: Schema.Literal("approve"), reason: Schema.optional(Schema.String) }),
  Schema.Struct({ verdict: Schema.Literal("deny"), reason: Schema.optional(Schema.String) }),
  Schema.Struct({ verdict: Schema.Literal("escalate"), reason: Schema.optional(Schema.String) })
])
export type ReviewVerdict = typeof ReviewVerdict.Type

/** The call a reviewer is asked about, with what the catalog knows of its tool. */
export interface ApprovalReviewRequest {
  readonly tenantId: TenantId
  readonly approval: PendingApproval
  readonly profile: Profile
  readonly connection: ConnectionRef
  readonly tool: {
    readonly alias: Alias
    readonly name: ToolName
    readonly description?: string
    readonly inputSchema?: Json
    readonly readOnly?: boolean
    readonly destructive?: boolean
    readonly idempotent?: boolean
  }
}

/**
 * Consulted when a call that asks is frozen, before any human is notified. An
 * approval runs the call at once and a denial refuses it, both recorded as
 * decided by `reviewer:<name>`; escalating leaves the call waiting for a human
 * as if there were no reviewer. A reviewer that fails, or does not answer
 * within its `timeout` (a minute by default), escalates.
 */
export class ApprovalReviewer extends Context.Service<
  ApprovalReviewer,
  {
    readonly name: string
    readonly timeout?: Duration.Input
    readonly review: (request: ApprovalReviewRequest) => Effect.Effect<ReviewVerdict>
  }
>()("@integragents/gateway-core/ApprovalReviewer") {}

/** Who the reviewer's decisions are recorded as. */
export const reviewerIdentity = (reviewer: ApprovalReviewer["Service"]): string => `reviewer:${reviewer.name}`

const DEFAULT_REVIEW_TIMEOUT: Duration.Input = "1 minute"

/** The reviewer's verdict, or an escalation when it could not give one in time. */
export const consultReviewer = (
  reviewer: ApprovalReviewer["Service"],
  request: ApprovalReviewRequest
): Effect.Effect<ReviewVerdict> =>
  reviewer.review(request).pipe(
    Effect.timeout(reviewer.timeout ?? DEFAULT_REVIEW_TIMEOUT),
    Effect.catchCause((cause) =>
      Effect.as(
        Effect.logWarning(`${reviewerIdentity(reviewer)} failed or did not answer; leaving the call to a human`, cause),
        { verdict: "escalate", reason: "the reviewer did not answer" } satisfies ReviewVerdict
      )
    ),
    Effect.withSpan("Approvals.review", { attributes: { reviewer: reviewer.name, "approval.id": request.approval.id } })
  )
