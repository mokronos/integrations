import { createHmac, timingSafeEqual } from "node:crypto"
import { Effect, Schema } from "effect"
import { FetchHttpClient, HttpBody, HttpClient, HttpClientResponse } from "effect/unstable/http"
import { whenPresent } from "@mokronos/contracts"
import type { GatewayStore } from "./store-contract.ts"

export const ApprovalNotification = Schema.Struct({
  version: Schema.Literal(1), event: Schema.Literal("approval.pending"),
  approvalId: Schema.String, clientId: Schema.String, clientName: Schema.String,
  alias: Schema.String, tool: Schema.String, expiresAt: Schema.String,
  approvalUrl: Schema.optional(Schema.String)
})
export type ApprovalNotification = typeof ApprovalNotification.Type

export const approvalWebhookSignature = (secret: string, timestamp: string, body: string): string =>
  `v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`

export const verifyApprovalWebhookSignature = (input: {
  readonly secret: string; readonly timestamp: string; readonly body: string; readonly signature: string
}): boolean => {
  const expected = Buffer.from(approvalWebhookSignature(input.secret, input.timestamp, input.body))
  const presented = Buffer.from(input.signature)
  return expected.length === presented.length && timingSafeEqual(expected, presented)
}

class ApprovalWebhookError extends Schema.TaggedError<ApprovalWebhookError>()(
  "ApprovalWebhookError", { message: Schema.String }
) {}

export const deliverDueApprovalNotifications = Effect.fn("Approval.deliverDueNotifications")(
  function*(input: {
    readonly store: GatewayStore
    readonly dashboardUrl?: string
    readonly limit?: number
    readonly now?: Date
  }) {
    const at = input.now ?? new Date()
    const jobs = yield* input.store.claimDueApprovalDeliveries(at, input.limit ?? 25)
    const client = yield* HttpClient.HttpClient
    yield* Effect.forEach(jobs, (job) => Effect.gen(function*() {
      const approvalUrl = input.dashboardUrl === undefined ? undefined
        : `${input.dashboardUrl.replace(/\/+$/, "")}/approvals?approval=${encodeURIComponent(job.approvalId)}`
      const notification: ApprovalNotification = {
        version: 1, event: "approval.pending", approvalId: job.approvalId,
        clientId: job.clientId, clientName: job.clientName, alias: job.alias,
        tool: job.tool, expiresAt: job.expiresAt.toISOString(),
        ...whenPresent("approvalUrl", approvalUrl)
      }
      const body = JSON.stringify(notification)
      const timestamp = Math.floor(at.getTime() / 1_000).toString()
      const delivery = client.post(job.url, {
        headers: {
          "idempotency-key": job.id,
          "x-integrations-delivery": job.id, "x-integrations-event": "approval.pending",
          "x-integrations-timestamp": timestamp,
          "x-integrations-signature": approvalWebhookSignature(job.signingSecret, timestamp, body)
        },
        body: HttpBody.text(body, "application/json")
      }).pipe(
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
        Effect.timeout(5_000),
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.asVoid,
        Effect.mapError((cause) => new ApprovalWebhookError({ message: cause.message }))
      )
      yield* delivery.pipe(Effect.matchEffect({
        onSuccess: () => input.store.settleApprovalDelivery({
          id: job.id, status: "delivered", nextAttemptAt: null, error: null
        }),
        onFailure: (error) => {
          const attempts = job.attempts + 1
          const next = new Date(at.getTime() + Math.min(60 * 60_000, 2 ** Math.min(attempts, 10) * 1_000))
          const terminal = attempts >= 8 || next >= job.expiresAt
          return input.store.settleApprovalDelivery({
            id: job.id, status: terminal ? "failed" : "retrying",
            nextAttemptAt: terminal ? null : next, error: error.message
          })
        }
      }))
    }), { concurrency: 5, discard: true })
  }
)
