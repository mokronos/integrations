import { createHmac, timingSafeEqual } from "node:crypto"
import { DateTime, Duration, Effect, Random, Schema } from "effect"
import { FetchHttpClient, HttpBody, HttpClient, HttpClientResponse } from "effect/unstable/http"
import { utf8Bytes, whenPresent } from "@mokronos/contracts"
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
  const expected = utf8Bytes(approvalWebhookSignature(input.secret, input.timestamp, input.body))
  const presented = utf8Bytes(input.signature)
  return expected.length === presented.length && timingSafeEqual(expected, presented)
}

class ApprovalWebhookError extends Schema.TaggedError<ApprovalWebhookError>()(
  "ApprovalWebhookError", { message: Schema.String }
) {}

/** A delivery that has failed this many times is given up on. */
const deliveryAttemptLimit = 8

const deliveryBackoffBase = Duration.seconds(1)

/**
 * How long to wait before the next attempt. A delivery's retry state lives in
 * the database rather than in a fiber, so the wait is computed for the attempt
 * at hand rather than driven by a Schedule. The jitter keeps a batch of
 * deliveries that failed together — a destination going down takes all of its
 * jobs with it — from coming back in lockstep.
 */
const backoffAfter = (attempt: number): Effect.Effect<Duration.Duration> =>
  Effect.map(Random.next, (random) =>
    Duration.times(
      Duration.times(deliveryBackoffBase, 2 ** attempt),
      0.8 + random * 0.4
    ))

export const deliverDueApprovalNotifications = Effect.fn("Approval.deliverDueNotifications")(
  function*(input: {
    readonly store: GatewayStore
    readonly dashboardUrl?: string
    readonly limit?: number
    readonly now?: Date
  }) {
    const at = input.now ?? (yield* DateTime.nowAsDate)
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
        onFailure: (error) =>
          Effect.gen(function*() {
            const attempts = job.attempts + 1
            const next = new Date(
              at.getTime() + Duration.toMillis(yield* backoffAfter(attempts))
            )
            const terminal = attempts >= deliveryAttemptLimit || next >= job.expiresAt
            return yield* input.store.settleApprovalDelivery({
              id: job.id, status: terminal ? "failed" : "retrying",
              nextAttemptAt: terminal ? null : next, error: error.message
            })
          })
      }))
    }), { concurrency: 5, discard: true })
  }
)
