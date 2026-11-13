import { createHmac, timingSafeEqual } from "node:crypto"
import { Clock, Effect, Option, Predicate, Result, Schema } from "effect"
import { Base64 } from "effect/encoding"
import {
  EventCursor,
  EventTermination,
  utf8Bytes,
  utf8Text,
  WebhookSecret,
  webhookSecretPrefix
} from "@integragents/contracts"
import type { WebhookDelivery } from "@integragents/contracts"
import { decodeWireOccurrence, occurrenceOf } from "./events.ts"

/**
 * The receiving end of MCP Events webhook delivery (SEP-3415), for the
 * application embedding the gateway to call from its own HTTP route. It
 * checks a POST the way the Standard Webhooks profile says, and answers the
 * verification challenge itself; what to do with an event is the caller's.
 */

/** The headers a delivery carries; `webhook-*` are Standard Webhooks', the last is MCP's own. */
export const webhookHeaders = {
  id: "webhook-id",
  timestamp: "webhook-timestamp",
  signature: "webhook-signature",
  subscription: "x-mcp-subscription-id"
} as const

/** How far a delivery's timestamp may be from now, either way: the profile's five minutes. */
export const webhookTolerance = { seconds: 300 } as const

export const WebhookRejection = Schema.Literals([
  /** A required header is absent or not in its form. */
  "malformed_headers",
  /** The timestamp is further from now than the tolerance: replayed, or a skewed clock. */
  "stale_timestamp",
  /** The delivery names another subscription than the one whose secret was given. */
  "subscription_mismatch",
  /** No signature verifies under any of the secrets given. */
  "bad_signature",
  /** Signed, but the body is no event or control envelope. */
  "malformed_body"
])
export type WebhookRejection = typeof WebhookRejection.Type

/** A POST the receiver refused. Answer it with `status`; never act on its body. */
export class WebhookRejected extends Schema.TaggedError<WebhookRejected>()("WebhookRejected", {
  rejection: WebhookRejection,
  detail: Schema.String
}) {
  /** 401 for anything the signature scheme rejects, so the sender does not read it as a server fault. */
  get status(): number {
    return this.rejection === "malformed_body" || this.rejection === "malformed_headers" ? 400 : 401
  }
  override get message(): string {
    return `Webhook delivery rejected (${this.rejection}): ${this.detail}`
  }
}

/** What the receiver needs to know a POST: its headers, and its body exactly as it arrived. */
export interface WebhookRequest {
  readonly headers: globalThis.Headers
  /** The raw bytes, never JSON parsed and serialised again: the signature covers them as sent. */
  readonly body: Uint8Array | string
}

export interface WebhookKeys {
  /**
   * The secrets the delivery may be signed with: the one bound to its
   * subscription, both while one is rotated, or, for the first verification
   * of a new subscription, every secret not yet bound to an `id`.
   */
  readonly secrets: ReadonlyArray<WebhookSecret>
  /** The subscription the secrets belong to, when the caller knows it; a delivery naming another is rejected. */
  readonly subscriptionId?: string
}

/** A delivery that verified: what it said, which secret signed it, and what to answer the POST with. */
export interface WebhookReceipt {
  readonly delivery: WebhookDelivery
  readonly secret: WebhookSecret
  /**
   * The HTTP answer. A verification is answered with its challenge at once;
   * anything else only once the caller has stored or forwarded it, since a
   * 2xx tells the server it need not deliver it again.
   */
  readonly answer: { readonly status: number; readonly body: string; readonly contentType?: string }
}

const WebhookId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,256}$/))
const decodeWebhookId = Schema.decodeUnknownOption(WebhookId)

const ControlEnvelope = Schema.Union([
  Schema.Struct({ type: Schema.Literal("gap"), cursor: Schema.optional(EventCursor) }),
  Schema.Struct({ type: Schema.Literal("terminated"), error: EventTermination }),
  Schema.Struct({ type: Schema.Literal("verification"), challenge: Schema.String })
])
const decodeControl = Schema.decodeUnknownOption(ControlEnvelope)
const Typed = Schema.Struct({ type: Schema.String })
const decodeTyped = Schema.decodeUnknownOption(Typed)
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))

const rejected = (rejection: WebhookRejection, detail: string) => new WebhookRejected({ rejection, detail })

const secretKey = (secret: WebhookSecret): Uint8Array =>
  Result.getOrElse(Base64.decode(secret.slice(webhookSecretPrefix.length)), () => new Uint8Array())

/** `v1,<base64 HMAC-SHA256(secret, "<id>.<timestamp>." + body)>`, as Standard Webhooks signs. */
export const webhookSignature = (
  secret: WebhookSecret,
  webhookId: string,
  timestamp: string,
  body: Uint8Array | string
): string => {
  const mac = createHmac("sha256", secretKey(secret))
  mac.update(utf8Bytes(`${webhookId}.${timestamp}.`))
  mac.update(Predicate.isString(body) ? utf8Bytes(body) : body)
  return `v1,${mac.digest("base64")}`
}

/** The `v1` signatures a header lists; other schemes, such as the asymmetric `v1a`, are not checked here. */
const presentedSignatures = (header: string): ReadonlyArray<Uint8Array> =>
  header
    .split(" ")
    .filter((entry) => entry.startsWith("v1,"))
    .flatMap((entry) =>
      Result.match(Base64.decode(entry.slice(3)), { onFailure: () => [], onSuccess: (bytes) => [bytes] })
    )

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.byteLength === right.byteLength && timingSafeEqual(left, right)

/** The secret one of the presented signatures verifies under, compared in constant time. */
const signingSecret = (
  secrets: ReadonlyArray<WebhookSecret>,
  presented: ReadonlyArray<Uint8Array>,
  webhookId: string,
  timestamp: string,
  body: Uint8Array | string
): Option.Option<WebhookSecret> =>
  Option.fromNullishOr(
    secrets.find((secret) => {
      const expected = Result.getOrElse(
        Base64.decode(webhookSignature(secret, webhookId, timestamp, body).slice(3)),
        () => new Uint8Array()
      )
      // Every presented signature is compared, so how long this takes says nothing about which matched.
      return presented.map((signature) => sameBytes(signature, expected)).includes(true)
    })
  )

const required = (headers: globalThis.Headers, name: string): Effect.Effect<string, WebhookRejected> => {
  const value = headers.get(name)
  return value === null || value.length === 0
    ? Effect.fail(rejected("malformed_headers", `the ${name} header is missing`))
    : Effect.succeed(value)
}

const deliveryOf = (
  body: string,
  subscriptionId: string,
  webhookId: string
): Effect.Effect<WebhookDelivery, WebhookRejected> => {
  const parsed = decodeJson(body)
  if (Option.isNone(parsed)) return Effect.fail(rejected("malformed_body", "the body is not JSON"))
  const envelope = { subscriptionId, webhookId }
  // A body with a top-level `type` is a control envelope; one without is an event.
  if (Option.isSome(decodeTyped(parsed.value))) {
    return Option.match(decodeControl(parsed.value), {
      onNone: () => Effect.fail(rejected("malformed_body", "the body is no control envelope this receiver knows")),
      onSome: (control): Effect.Effect<WebhookDelivery, WebhookRejected> => {
        switch (control.type) {
          case "gap":
            return Effect.succeed({ _tag: "gap", ...envelope, cursor: control.cursor ?? null })
          case "terminated":
            return Effect.succeed({ _tag: "terminated", ...envelope, error: control.error })
          case "verification":
            return Effect.succeed({ _tag: "verification", ...envelope, challenge: control.challenge })
        }
      }
    })
  }
  return Option.match(decodeWireOccurrence(parsed.value), {
    onNone: () => Effect.fail(rejected("malformed_body", "the body is no event occurrence")),
    onSome: (occurrence) => Effect.succeed({ _tag: "event", ...envelope, event: occurrenceOf(occurrence) })
  })
}

const answerTo = (delivery: WebhookDelivery): WebhookReceipt["answer"] =>
  delivery._tag === "verification"
    ? { status: 200, body: JSON.stringify({ challenge: delivery.challenge }), contentType: "application/json" }
    : { status: 204, body: "" }

/**
 * Verifies one webhook POST and says what it delivered. Nothing in the body
 * is read before the signature verifies over the raw bytes, under one of
 * `keys.secrets`, with a timestamp within five minutes of now.
 */
export const receiveWebhook = Effect.fn("Events.receiveWebhook")(function* (
  request: WebhookRequest,
  keys: WebhookKeys
): Effect.fn.Return<WebhookReceipt, WebhookRejected> {
  const webhookId = yield* required(request.headers, webhookHeaders.id)
  const timestamp = yield* required(request.headers, webhookHeaders.timestamp)
  const signatures = yield* required(request.headers, webhookHeaders.signature)
  const subscriptionId = yield* required(request.headers, webhookHeaders.subscription)
  if (Option.isNone(decodeWebhookId(webhookId))) {
    return yield* rejected("malformed_headers", "the webhook-id holds characters outside letters, digits, _ and -")
  }
  if (!/^\d{1,12}$/.test(timestamp)) {
    return yield* rejected("malformed_headers", "the webhook-timestamp is not a Unix time in seconds")
  }
  const nowSeconds = Math.floor((yield* Clock.currentTimeMillis) / 1000)
  if (Math.abs(nowSeconds - Number(timestamp)) > webhookTolerance.seconds) {
    return yield* rejected("stale_timestamp", `signed at ${timestamp}, more than five minutes from now`)
  }
  if (keys.subscriptionId !== undefined && keys.subscriptionId !== subscriptionId) {
    return yield* rejected("subscription_mismatch", "the delivery names another subscription")
  }
  const secret = signingSecret(keys.secrets, presentedSignatures(signatures), webhookId, timestamp, request.body)
  if (Option.isNone(secret)) {
    return yield* rejected("bad_signature", "no signature verifies under the subscription's secret")
  }
  const text = Predicate.isString(request.body) ? request.body : utf8Text(request.body)
  const delivery = yield* deliveryOf(text, subscriptionId, webhookId)
  yield* Effect.annotateCurrentSpan({ "mcp.webhook.delivery": delivery._tag })
  return { delivery, secret: secret.value, answer: answerTo(delivery) }
})

/** A fresh signing secret: `whsec_` and 32 bytes from the platform's CSPRNG. Make one per subscription. */
export const generateWebhookSecret: Effect.Effect<WebhookSecret> = Effect.sync(() =>
  WebhookSecret.make(`${webhookSecretPrefix}${Base64.encode(globalThis.crypto.getRandomValues(new Uint8Array(32)))}`)
)
