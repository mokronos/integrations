import { Schema } from "effect"
import { ToolMeta } from "./tool.ts"
import { Alias, ConnectionName, ConnectionOwner, IntegrationSlug } from "./vocabulary.ts"

/**
 * MCP Events (SEP-3415): a server lists the kinds of thing that can happen
 * upstream, and a client polls for them or has them POSTed to a webhook.
 * Shapes here are the gateway's own: `meta` is MCP's `_meta`, and an absent
 * cursor is `null`, which the extension says means the same.
 */
export const mcpEventsExtension = "io.modelcontextprotocol/events"

/** How occurrences of an event type can reach a client. The gateway polls and subscribes webhooks; it does not hold `push` streams. */
export const EventDeliveryMode = Schema.Literals(["poll", "push", "webhook"])
export type EventDeliveryMode = typeof EventDeliveryMode.Type

/** One JSON object, as subscription arguments and event payloads are. */
export const JsonObjectSchema = Schema.Record(Schema.String, Schema.Json)

/** One event type as its server describes it. */
export const EventTypeDescriptor = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  delivery: Schema.NonEmptyArray(EventDeliveryMode),
  /** JSON Schema for the arguments a subscription passes. */
  inputSchema: Schema.optional(Schema.Json),
  /** JSON Schema for each occurrence's `data`. */
  payloadSchema: Schema.optional(Schema.Json),
  meta: Schema.optional(ToolMeta)
})
export type EventTypeDescriptor = typeof EventTypeDescriptor.Type

/** An event type in the catalog: what one connection's server listed, and when. */
export const EventType = Schema.Struct({
  ...EventTypeDescriptor.fields,
  owner: ConnectionOwner,
  integration: IntegrationSlug,
  connection: ConnectionName,
  capturedAt: Schema.Number
})
export type EventType = typeof EventType.Type

/** An event type a profile reaches, under the alias of the connection that lists it. */
export const ProfileEventType = Schema.Struct({ alias: Alias, ...EventTypeDescriptor.fields })
export type ProfileEventType = typeof ProfileEventType.Type

/** A position in an event stream, opaque to the client; `null` starts from now, or says the type keeps no history. */
export const EventCursor = Schema.NullOr(Schema.String)
export type EventCursor = typeof EventCursor.Type

/** One thing that happened upstream. Its `data` is untrusted, like a tool result. */
export const EventOccurrence = Schema.Struct({
  /** The upstream event's identity, for deduplicating within one subscription. */
  eventId: Schema.String,
  name: Schema.String,
  /** ISO 8601, when it happened. */
  timestamp: Schema.String,
  data: JsonObjectSchema,
  /** Webhook deliveries only: the safe-to-persist position after this occurrence. */
  cursor: Schema.optional(EventCursor),
  meta: Schema.optional(ToolMeta)
})
export type EventOccurrence = typeof EventOccurrence.Type

const PositiveCount = Schema.Int.check(Schema.isGreaterThan(0))
const Milliseconds = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/** One `events/poll`: one subscription, given whole on every poll, since the server keeps nothing between them. */
export const EventPoll = Schema.Struct({
  name: Schema.String,
  arguments: Schema.optional(JsonObjectSchema),
  /** The cursor the last poll returned; absent or `null` starts from now and returns no events. */
  cursor: Schema.optional(EventCursor),
  maxEvents: Schema.optional(PositiveCount),
  /** Replay nothing older than this, however old the cursor. */
  maxAgeMs: Schema.optional(Milliseconds)
})
export type EventPoll = typeof EventPoll.Type

export const EventPollResult = Schema.Struct({
  events: Schema.Array(EventOccurrence),
  /** Pass it to the next poll; `null` when the type keeps no history. */
  cursor: EventCursor,
  /** Events between the given cursor and this batch were skipped. */
  truncated: Schema.Boolean,
  /** More are waiting: poll again now instead of after `nextPollMs`. */
  hasMore: Schema.Boolean,
  /** When the server suggests polling next; absent leaves it to the client. */
  nextPollMs: Schema.optional(Schema.Number)
})
export type EventPollResult = typeof EventPollResult.Type

/**
 * A Standard Webhooks signing secret: `whsec_` and the base64 of 24 to 64
 * random bytes. The client makes it; the server only signs with it.
 */
export const webhookSecretPrefix = "whsec_"

/** How many bytes the base64 after `whsec_` decodes to. */
const secretBytes = (secret: string): number => {
  const encoded = secret.slice(webhookSecretPrefix.length)
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0
  return (encoded.length / 4) * 3 - padding
}

export const WebhookSecret = Schema.String.check(
  Schema.isPattern(/^whsec_(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{4})$/),
  Schema.makeFilter((secret: string) => {
    const bytes = secretBytes(secret)
    return (bytes >= 24 && bytes <= 64) || `holds ${bytes} bytes; a webhook secret holds 24 to 64`
  })
).pipe(Schema.brand("WebhookSecret"))
export type WebhookSecret = typeof WebhookSecret.Type

/** One `events/subscribe`: subscribes, or refreshes the subscription with the same name, arguments and URL. */
export const EventSubscribe = Schema.Struct({
  name: Schema.String,
  arguments: Schema.optional(JsonObjectSchema),
  /** The `https` URL the server POSTs deliveries to. */
  url: Schema.String,
  secret: WebhookSecret,
  cursor: Schema.optional(EventCursor),
  maxAgeMs: Schema.optional(Milliseconds),
  /** The lifetime to ask for; absent takes the server's default, `null` asks for no expiry. */
  ttlMs: Schema.optional(Schema.NullOr(Milliseconds))
})
export type EventSubscribe = typeof EventSubscribe.Type

/** How a server's deliveries to a webhook subscription are going; a server may not say. */
export const EventDeliveryStatus = Schema.Struct({
  active: Schema.Boolean,
  lastDeliveryAt: Schema.optional(Schema.NullOr(Schema.String)),
  /** A category: connection_refused, timeout, tls_error, http_4xx, http_5xx or challenge_failed. */
  lastError: Schema.optional(Schema.NullOr(Schema.String)),
  failedSince: Schema.optional(Schema.NullOr(Schema.String)),
  throttled: Schema.optional(Schema.Boolean),
  retryAfterMs: Schema.optional(Schema.Number)
})
export type EventDeliveryStatus = typeof EventDeliveryStatus.Type

export const EventSubscription = Schema.Struct({
  /** The server's handle for the subscription; deliveries carry it in `X-MCP-Subscription-Id`. */
  id: Schema.String,
  /** ISO 8601: subscribe again before then. `null`: it does not expire. */
  refreshBefore: Schema.NullOr(Schema.String),
  cursor: EventCursor,
  truncated: Schema.Boolean,
  deliveryStatus: Schema.optional(EventDeliveryStatus)
})
export type EventSubscription = typeof EventSubscription.Type

/** One `events/unsubscribe`: the same name, arguments and URL the subscription was made with. */
export const EventUnsubscribe = Schema.Struct({
  name: Schema.String,
  arguments: Schema.optional(JsonObjectSchema),
  url: Schema.String
})
export type EventUnsubscribe = typeof EventUnsubscribe.Type

/** The JSON-RPC error a `terminated` webhook envelope carries. */
export const EventTermination = Schema.Struct({
  code: Schema.Number,
  message: Schema.String,
  data: Schema.optional(Schema.Json)
})
export type EventTermination = typeof EventTermination.Type

/** What a verified webhook POST said, after the receiver answered any challenge itself. */
export const WebhookDelivery = Schema.Union([
  Schema.TaggedStruct("event", { subscriptionId: Schema.String, webhookId: Schema.String, event: EventOccurrence }),
  /** Events were skipped; persist `cursor` and treat it as a truncation. */
  Schema.TaggedStruct("gap", { subscriptionId: Schema.String, webhookId: Schema.String, cursor: EventCursor }),
  /** The subscription no longer exists on the server. */
  Schema.TaggedStruct("terminated", {
    subscriptionId: Schema.String,
    webhookId: Schema.String,
    error: EventTermination
  }),
  /** The server checking the endpoint wants deliveries; answered in the HTTP response, never forwarded. */
  Schema.TaggedStruct("verification", {
    subscriptionId: Schema.String,
    webhookId: Schema.String,
    challenge: Schema.String
  })
])
export type WebhookDelivery = typeof WebhookDelivery.Type
