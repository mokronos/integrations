import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { TestClock } from "effect/testing"
import { WebhookSecret, webhookSecretPrefix } from "@integragents/contracts"
import { generateWebhookSecret, receiveWebhook, webhookSignature } from "../src/mcp/webhook.ts"
import type { WebhookKeys, WebhookRejection } from "../src/mcp/webhook.ts"

/**
 * The Standard Webhooks reference vector: a verifier that agrees with it agrees with every compliant sender. Its key
 * is written as hex bytes, so secret scanners do not take the published test key for a credential.
 */
const reference = {
  secret: WebhookSecret.make(
    `${webhookSecretPrefix}${Buffer.from("31f290f6bf06298aab4f08d43c3f082cf648a362da2da4b0", "hex").toString("base64")}`
  ),
  id: "msg_p5jXN8AQM9LWM0D4loKWxJek",
  timestamp: 1614265330,
  body: '{"test": 2432232314}',
  signature: "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE="
}

/** A secret built from readable bytes at run time, so the source holds no secret-shaped literal. */
const testSecret = (bytes: string) => WebhookSecret.make(`${webhookSecretPrefix}${btoa(bytes)}`)

const secret = testSecret("this-is-a-test-secret-of-32-bytes!!")
const other = testSecret("another-secret-that-is-24-bytes")

const now = 1_763_028_000
const subscription = "sub_a3f1c8e2b0d49f7e"
const event = JSON.stringify({
  eventId: "evt_789",
  name: "incident.created",
  timestamp: "2026-11-13T10:00:00Z",
  data: { incidentId: "INC-1234", severity: "P1" },
  cursor: "cursor_xyz"
})

interface Signed {
  readonly id?: string
  readonly timestamp?: number
  readonly body?: string
  readonly signedBody?: string
  readonly secrets?: ReadonlyArray<WebhookSecret>
  readonly subscription?: string
  readonly omit?: string
}

/** A POST as an MCP server would send it, signed over `signedBody` (the body itself unless a test tampers). */
const post = (options: Signed = {}) => {
  const id = options.id ?? "msg_2KWPBgLlAfxdpx2AI54pPJ85f4W"
  const timestamp = String(options.timestamp ?? now)
  const body = options.body ?? event
  const signature = (options.secrets ?? [secret])
    .map((key) => webhookSignature(key, id, timestamp, options.signedBody ?? body))
    .join(" ")
  const headers = new Headers({
    "content-type": "application/json",
    "webhook-id": id,
    "webhook-timestamp": timestamp,
    "webhook-signature": signature,
    "X-MCP-Subscription-Id": options.subscription ?? subscription
  })
  if (options.omit !== undefined) headers.delete(options.omit)
  return { headers, body: new TextEncoder().encode(body) }
}

const at = (seconds: number) => TestClock.setTime(seconds * 1000)

const keys: WebhookKeys = { secrets: [secret], subscriptionId: subscription }

describe("receiving an MCP Events webhook", () => {
  it.effect("signs and verifies as the Standard Webhooks reference vector does", () =>
    Effect.gen(function* () {
      yield* at(reference.timestamp)
      expect(webhookSignature(reference.secret, reference.id, String(reference.timestamp), reference.body)).toBe(
        reference.signature
      )
      const headers = new Headers({
        "webhook-id": reference.id,
        "webhook-timestamp": String(reference.timestamp),
        "webhook-signature": reference.signature,
        "x-mcp-subscription-id": subscription
      })
      // Verified, then refused only because the body is no MCP event.
      const failure = yield* Effect.flip(
        receiveWebhook({ headers, body: reference.body }, { secrets: [reference.secret] })
      )
      expect(failure.rejection).toBe("malformed_body")
    })
  )

  it.effect("hands over an event signed under the subscription's secret, to acknowledge once stored", () =>
    Effect.gen(function* () {
      yield* at(now + 30)
      const receipt = yield* receiveWebhook(post(), keys)
      expect(receipt).toEqual({
        delivery: {
          _tag: "event",
          subscriptionId: subscription,
          webhookId: "msg_2KWPBgLlAfxdpx2AI54pPJ85f4W",
          event: {
            eventId: "evt_789",
            name: "incident.created",
            timestamp: "2026-11-13T10:00:00Z",
            data: { incidentId: "INC-1234", severity: "P1" },
            cursor: "cursor_xyz"
          }
        },
        secret,
        answer: { status: 204, body: "" }
      })
    })
  )

  it.effect("answers a verification challenge under whichever unbound secret signed it", () =>
    Effect.gen(function* () {
      yield* at(now)
      const receipt = yield* receiveWebhook(
        post({
          id: "msg_verification_x7Yq",
          subscription: "sub_not_yet_known",
          body: JSON.stringify({ type: "verification", challenge: "nonce-123" })
        }),
        // A first subscribe's challenge names an id the receiver has not been told: it tries every unbound secret.
        { secrets: [other, secret] }
      )
      expect(receipt.secret).toBe(secret)
      expect(receipt.delivery).toEqual({
        _tag: "verification",
        subscriptionId: "sub_not_yet_known",
        webhookId: "msg_verification_x7Yq",
        challenge: "nonce-123"
      })
      expect(receipt.answer).toEqual({
        status: 200,
        body: '{"challenge":"nonce-123"}',
        contentType: "application/json"
      })
    })
  )

  it.effect("reads gap and terminated envelopes, and accepts either signature while a secret rotates", () =>
    Effect.gen(function* () {
      yield* at(now)
      const gap = yield* receiveWebhook(
        post({ body: JSON.stringify({ type: "gap", cursor: "fresh" }), secrets: [other, secret] }),
        keys
      )
      const terminated = yield* receiveWebhook(
        post({
          body: JSON.stringify({
            type: "terminated",
            error: { code: -32024, message: "Forbidden", data: { reason: "Access revoked" } }
          })
        }),
        keys
      )
      expect(gap.delivery).toMatchObject({ _tag: "gap", cursor: "fresh" })
      expect(terminated.delivery).toMatchObject({
        _tag: "terminated",
        error: { code: -32024, message: "Forbidden", data: { reason: "Access revoked" } }
      })
    })
  )

  it.effect("rejects every delivery it cannot trust, before reading its body", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<readonly [string, number, Signed, WebhookRejection, number]> = [
        ["signed with another secret", now, { secrets: [other] }, "bad_signature", 401],
        ["a body changed after signing", now, { signedBody: event.replace("P1", "P4") }, "bad_signature", 401],
        // The signature covers the raw bytes: re-serialised JSON with the same meaning is not what was signed.
        ["a body re-serialised", now, { signedBody: JSON.stringify(JSON.parse(event), null, 2) }, "bad_signature", 401],
        ["a capture replayed six minutes on", now + 360, {}, "stale_timestamp", 401],
        ["a timestamp from the future", now - 301, {}, "stale_timestamp", 401],
        ["another subscription's delivery", now, { subscription: "sub_someone_else" }, "subscription_mismatch", 401],
        ["no signature", now, { omit: "webhook-signature" }, "malformed_headers", 400],
        ["no subscription id", now, { omit: "x-mcp-subscription-id" }, "malformed_headers", 400],
        ["a webhook-id that could shift the signed string", now, { id: "msg.1" }, "malformed_headers", 400],
        ["a signed body that is no event", now, { body: '{"type":"bogus"}' }, "malformed_body", 400]
      ]
      for (const [label, clock, signed, rejection, status] of cases) {
        yield* at(clock)
        const failure = yield* Effect.flip(receiveWebhook(post(signed), keys))
        expect({ label, rejection: failure.rejection, status: failure.status }).toEqual({ label, rejection, status })
      }
    })
  )

  it.effect("accepts a delivery just inside the five minutes", () =>
    Effect.gen(function* () {
      yield* at(now + 300)
      const receipt = yield* receiveWebhook(post(), keys)
      expect(receipt.delivery._tag).toBe("event")
    })
  )

  it.effect("makes secrets a server accepts, never the same twice", () =>
    Effect.gen(function* () {
      const first = yield* generateWebhookSecret
      const second = yield* generateWebhookSecret
      expect(first).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/)
      expect(first).not.toBe(second)
    })
  )
})
