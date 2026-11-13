import type { Client } from "@modelcontextprotocol/client"
import { Effect, Option, Schema } from "effect"
import {
  EventDeliveryMode,
  EventDeliveryStatus,
  EventCursor,
  JsonObjectSchema,
  mcpEventsExtension,
  ToolMeta,
  whenPresent,
  whenTrue
} from "@integragents/contracts"
import type {
  EventOccurrence,
  EventPoll,
  EventPollResult,
  EventSubscribe,
  EventSubscription,
  EventTypeDescriptor,
  EventUnsubscribe,
  Json
} from "@integragents/contracts"
import { EventsRefused, eventsRefusalCodes, McpError } from "../errors.ts"
import { asMcpError } from "./session.ts"
import type { Session, SessionFailure } from "./session.ts"

/**
 * The client half of MCP Events (SEP-3415) over one session: `events/list`,
 * `events/poll`, `events/subscribe` and `events/unsubscribe`. The SDK knows
 * none of them, so each goes out as a custom request whose result is decoded
 * here. `events/stream` is left out: the gateway holds no push streams.
 */

const EventsCapability = Schema.Struct({
  extensions: Schema.Struct({
    [mcpEventsExtension]: Schema.Struct({ listChanged: Schema.optional(Schema.Boolean) })
  })
})
const decodeCapability = Schema.decodeUnknownOption(EventsCapability)

/** Whether the server declared the extension; a client must not send `events/*` to one that did not. */
export const offersEvents = (client: Client): boolean => Option.isSome(decodeCapability(client.getServerCapabilities()))

/** Any JSON result; each method decodes its own shape so a bad answer is a protocol failure, not an SDK one. */
const anyResult = Schema.toStandardSchemaV1(Schema.Json)

const knownModes = Schema.decodeUnknownOption(EventDeliveryMode)

const WireEventType = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  /** Kept as text: a mode a later revision adds is skipped rather than failing the listing. */
  delivery: Schema.Array(Schema.String),
  inputSchema: Schema.optional(Schema.Json),
  payloadSchema: Schema.optional(Schema.Json),
  _meta: Schema.optional(ToolMeta)
})
const WireEventList = Schema.Struct({
  events: Schema.Array(WireEventType),
  nextCursor: Schema.optional(Schema.NullOr(Schema.String))
})
const decodeEventList = Schema.decodeUnknownEffect(WireEventList)

const WireOccurrence = Schema.Struct({
  eventId: Schema.String,
  name: Schema.String,
  timestamp: Schema.String,
  data: JsonObjectSchema,
  cursor: Schema.optional(EventCursor),
  _meta: Schema.optional(ToolMeta)
})
export type WireOccurrence = typeof WireOccurrence.Type
export const decodeWireOccurrence = Schema.decodeUnknownOption(WireOccurrence)

const WirePollResult = Schema.Struct({
  events: Schema.Array(WireOccurrence),
  cursor: Schema.optional(EventCursor),
  truncated: Schema.optional(Schema.Boolean),
  hasMore: Schema.optional(Schema.Boolean),
  nextPollMs: Schema.optional(Schema.Number)
})
const decodePollResult = Schema.decodeUnknownEffect(WirePollResult)

const WireSubscription = Schema.Struct({
  id: Schema.String,
  /** Always present: absent would read as "no expiry", which only a request for it may grant. */
  refreshBefore: Schema.NullOr(Schema.String),
  cursor: Schema.optional(EventCursor),
  truncated: Schema.optional(Schema.Boolean),
  deliveryStatus: Schema.optional(EventDeliveryStatus)
})
const decodeSubscription = Schema.decodeUnknownEffect(WireSubscription)

/** `events/list` pages followed before the listing is cut short. */
const maxPages = 50

export const occurrenceOf = ({ _meta, ...rest }: WireOccurrence): EventOccurrence => ({
  ...rest,
  ...whenPresent("meta", _meta)
})

const descriptorOf = (wire: typeof WireEventType.Type): Option.Option<EventTypeDescriptor> => {
  const delivery = wire.delivery.flatMap((mode) => Option.toArray(knownModes(mode)))
  const [first, ...rest] = delivery
  if (first === undefined) return Option.none()
  return Option.some({
    name: wire.name,
    description: wire.description ?? "",
    delivery: [first, ...rest],
    ...whenPresent("inputSchema", wire.inputSchema),
    ...whenPresent("payloadSchema", wire.payloadSchema),
    ...whenPresent("meta", wire._meta)
  })
}

const unreadable = (endpoint: string, method: string) => (cause: Schema.SchemaError) =>
  new McpError({ endpoint, reason: "protocol", detail: `${method} returned an unreadable result`, cause })

const notOffered = (endpoint: string, method: string) =>
  new EventsRefused({
    endpoint,
    method,
    refusal: "unsupported",
    code: -32601,
    detail: "the server does not offer the events extension"
  })

const refusalOf =
  (endpoint: string, method: string) =>
  (failed: SessionFailure): Effect.Effect<never, McpError | EventsRefused> => {
    const rpc = Option.getOrUndefined(failed.rpc)
    const refusal = rpc === undefined ? undefined : eventsRefusalCodes.get(rpc.code)
    if (rpc === undefined || refusal === undefined) return asMcpError(endpoint, Option.some(method))(failed)
    return Effect.fail(
      new EventsRefused({
        endpoint,
        method,
        refusal,
        code: rpc.code,
        detail: rpc.message,
        ...whenPresent("data", Option.getOrUndefined(rpc.data))
      })
    )
  }

/** Sends one `events/*` request, telling the refusals SEP-3415 defines apart from every other failure. */
const send = (
  session: Session,
  endpoint: string,
  method: string,
  params: Record<string, Json>
): Effect.Effect<Json, McpError | EventsRefused> =>
  offersEvents(session.client)
    ? session
        .run((open, signal): Promise<Json> => open.request({ method, params }, anyResult, { signal }))
        .pipe(Effect.catchTag("SessionFailure", refusalOf(endpoint, method)))
    : Effect.fail(notOffered(endpoint, method))

/** Every event type the server lists, across its pages; none from a server without the extension. */
export const listEventTypes = (
  session: Session,
  endpoint: string
): Effect.Effect<ReadonlyArray<EventTypeDescriptor>, McpError | EventsRefused> =>
  Effect.gen(function* () {
    if (!offersEvents(session.client)) return []
    const listed: Array<EventTypeDescriptor> = []
    let cursor: string | undefined
    for (let page = 0; page < maxPages; page++) {
      const result = yield* send(session, endpoint, "events/list", whenPresent("cursor", cursor))
      const decoded = yield* decodeEventList(result).pipe(Effect.mapError(unreadable(endpoint, "events/list")))
      listed.push(...decoded.events.flatMap((wire) => Option.toArray(descriptorOf(wire))))
      cursor = decoded.nextCursor ?? undefined
      if (cursor === undefined) return listed
    }
    yield* Effect.logWarning("events/list was cut short after too many pages").pipe(
      Effect.annotateLogs({ "mcp.endpoint": endpoint, pages: maxPages })
    )
    return listed
  })

export const pollEvents = (
  session: Session,
  endpoint: string,
  poll: EventPoll
): Effect.Effect<EventPollResult, McpError | EventsRefused> =>
  send(session, endpoint, "events/poll", {
    name: poll.name,
    ...whenPresent("arguments", poll.arguments),
    cursor: poll.cursor ?? null,
    ...whenPresent("maxEvents", poll.maxEvents),
    ...whenPresent("maxAgeMs", poll.maxAgeMs)
  }).pipe(
    Effect.flatMap((result) => decodePollResult(result).pipe(Effect.mapError(unreadable(endpoint, "events/poll")))),
    Effect.map((result) => ({
      events: result.events.map(occurrenceOf),
      cursor: result.cursor ?? null,
      truncated: result.truncated ?? false,
      hasMore: result.hasMore ?? false,
      ...whenPresent("nextPollMs", result.nextPollMs)
    }))
  )

export const subscribeEvents = (
  session: Session,
  endpoint: string,
  subscribe: EventSubscribe
): Effect.Effect<EventSubscription, McpError | EventsRefused> =>
  send(session, endpoint, "events/subscribe", {
    name: subscribe.name,
    ...whenPresent("arguments", subscribe.arguments),
    delivery: { mode: "webhook", url: subscribe.url, secret: subscribe.secret },
    cursor: subscribe.cursor ?? null,
    ...whenPresent("maxAgeMs", subscribe.maxAgeMs),
    // Absent asks for the server's default; null asks for no expiry.
    ...whenTrue(subscribe.ttlMs !== undefined, () => ({ ttlMs: subscribe.ttlMs ?? null }))
  }).pipe(
    Effect.flatMap((result) =>
      decodeSubscription(result).pipe(Effect.mapError(unreadable(endpoint, "events/subscribe")))
    ),
    Effect.map((result) => ({
      id: result.id,
      refreshBefore: result.refreshBefore,
      cursor: result.cursor ?? null,
      truncated: result.truncated ?? false,
      ...whenPresent("deliveryStatus", result.deliveryStatus)
    }))
  )

export const unsubscribeEvents = (
  session: Session,
  endpoint: string,
  unsubscribe: EventUnsubscribe
): Effect.Effect<void, McpError | EventsRefused> =>
  Effect.asVoid(
    send(session, endpoint, "events/unsubscribe", {
      name: unsubscribe.name,
      ...whenPresent("arguments", unsubscribe.arguments),
      delivery: { url: unsubscribe.url }
    })
  )
