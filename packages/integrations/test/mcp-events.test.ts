import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Option, Schema } from "effect"
import type { Scope } from "effect"
import {
  isJsonObject,
  mcpEventsExtension,
  property,
  WebhookSecret,
  webhookSecretPrefix,
  whenPresent,
  whenTrue
} from "@integragents/contracts"
import type { Json } from "@integragents/contracts"
import { Egress } from "../src/egress/egress.ts"
import { defaultUrlPolicy } from "../src/egress/url-policy.ts"
import { McpClient } from "../src/mcp/client.ts"

const JsonRpcRequest = Schema.Struct({
  id: Schema.optional(Schema.Union([Schema.Number, Schema.String])),
  method: Schema.String,
  params: Schema.optional(Schema.Json)
})
type JsonRpcRequest = typeof JsonRpcRequest.Type
const decodeRequest = Schema.decodeUnknownOption(Schema.fromJsonString(JsonRpcRequest))

const complete = { resultType: "complete", ttlMs: 0, cacheScope: "private" }

/** One `events/*` request as the server saw it. */
interface Seen {
  readonly method: string
  readonly params: Json
  readonly mcpName: string | null
}

const created = {
  name: "ticket.created",
  description: "A ticket was opened",
  delivery: ["poll", "webhook"],
  inputSchema: { type: "object", properties: { queue: { type: "string" } } },
  payloadSchema: { type: "object", properties: { ticketId: { type: "string" } } }
}

const occurrence = (id: string) => ({
  eventId: id,
  name: "ticket.created",
  timestamp: "2026-11-13T10:00:00Z",
  data: { ticketId: id },
  _meta: { trace: id }
})

const rpcError = (id: JsonRpcRequest["id"], code: number, message: string, data: Json) =>
  Response.json({ jsonrpc: "2.0", id, error: { code, message, data } })

const result = (id: JsonRpcRequest["id"], body: Record<string, Json>) =>
  Response.json({ jsonrpc: "2.0", id, result: { resultType: "complete", ...body } })

/**
 * A 2026-07-28 server that implements the events methods over a small
 * ticket queue: two pages of event types, a cursor that replays two events
 * from `c0`, one too old to replay, and webhook subscriptions keyed as the
 * extension keys them.
 */
const eventsServer = (offersEvents: boolean, endlessListing: boolean) => {
  const seen: Array<Seen> = []
  const subscriptions = new Set<string>()
  const answer = (request: JsonRpcRequest, mcpName: string | null): Response => {
    const params = request.params ?? {}
    if (request.method.startsWith("events/")) seen.push({ method: request.method, params, mcpName })
    const name = property(params, "name")
    const key = JSON.stringify([property(property(params, "delivery"), "url"), name, property(params, "arguments")])
    switch (request.method) {
      case "server/discover":
        return Response.json({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            ...complete,
            supportedVersions: ["2026-07-28"],
            capabilities: {
              tools: { listChanged: false },
              ...whenTrue(offersEvents, () => ({ extensions: { [mcpEventsExtension]: { listChanged: true } } }))
            },
            _meta: { "io.modelcontextprotocol/serverInfo": { name: "Tickets", version: "1" } }
          }
        })
      case "tools/list":
        return Response.json({ jsonrpc: "2.0", id: request.id, result: { ...complete, tools: [] } })
      case "events/list":
        if (endlessListing) return result(request.id, { events: [created], nextCursor: crypto.randomUUID() })
        return property(params, "cursor") === "page-2"
          ? result(request.id, {
              events: [
                { name: "ticket.closed", delivery: ["push"] },
                // A mode from a later revision only: nothing this client can use.
                { name: "ticket.moved", delivery: ["carrier-pigeon"] }
              ]
            })
          : result(request.id, { events: [created], nextCursor: "page-2" })
      case "events/poll": {
        if (name !== "ticket.created") {
          return rpcError(request.id, -32023, "Unknown event type", { kind: "event" })
        }
        const cursor = property(params, "cursor")
        if (cursor === null) return result(request.id, { events: [], cursor: "c0", truncated: false, hasMore: false })
        if (cursor === "c0") {
          return property(params, "maxEvents") === 1
            ? result(request.id, {
                events: [occurrence("evt_1")],
                cursor: "c1",
                truncated: false,
                hasMore: true,
                nextPollMs: 0
              })
            : rpcError(request.id, -32602, "maxEvents must be 1 here", null)
        }
        if (cursor === "c1") {
          return result(request.id, {
            events: [occurrence("evt_2")],
            cursor: "c2",
            truncated: false,
            hasMore: false,
            nextPollMs: 30000
          })
        }
        // A cursor past the upstream's retention: start again from now, and say events were skipped.
        return result(request.id, { events: [], cursor: "c9", truncated: true, hasMore: false, nextPollMs: 30000 })
      }
      case "events/subscribe": {
        const delivery = property(params, "delivery")
        if (property(delivery, "mode") !== "webhook" || !String(property(delivery, "url")).startsWith("https://")) {
          return rpcError(request.id, -32602, "delivery.url must be https", null)
        }
        const refreshed = subscriptions.has(key)
        subscriptions.add(key)
        return result(request.id, {
          id: "sub_tickets",
          // Only an explicit null asks for no expiry; an absent ttlMs takes the server's default.
          refreshBefore: isJsonObject(params) && params["ttlMs"] === null ? null : "2026-11-13T11:00:00Z",
          cursor: refreshed ? "c2" : "c0",
          truncated: false,
          ...whenTrue(refreshed, () => ({ deliveryStatus: { active: true, lastDeliveryAt: null, lastError: null } }))
        })
      }
      case "events/unsubscribe":
        if (!subscriptions.delete(key)) {
          return rpcError(request.id, -32023, "No such subscription", { kind: "subscription" })
        }
        return result(request.id, {})
      default:
        return new Response(null, { status: 202 })
    }
  }
  return { seen, answer }
}

const serve = (
  offersEvents: boolean,
  endlessListing = false
): Effect.Effect<{ readonly endpoint: string; readonly seen: ReadonlyArray<Seen> }, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const server = eventsServer(offersEvents, endlessListing)
      const listener = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        idleTimeout: 0,
        async fetch(request) {
          if (request.method !== "POST") return new Response(null, { status: 405 })
          const body = decodeRequest(await request.text())
          return Option.match(body, {
            onNone: () => new Response(null, { status: 400 }),
            onSome: (message) => server.answer(message, request.headers.get("mcp-name"))
          })
        }
      })
      return { listener, seen: server.seen }
    }),
    ({ listener }) => Effect.promise(() => listener.stop(true))
  ).pipe(Effect.map(({ listener, seen }) => ({ endpoint: `http://127.0.0.1:${listener.port}/mcp`, seen })))

const services = McpClient.layer.pipe(Layer.provide(Egress.layer(defaultUrlPolicy)))

const server = (endpoint: string) => ({ endpoint, era: Option.none() })

const secret = WebhookSecret.make(`${webhookSecretPrefix}${btoa("a signing secret for the MCP events tests")}`)
const hook = "https://receiver.example.com/hooks/tickets"

describe("MCP Events client", () => {
  it.live("lists event types across pages, beside the tools, skipping a type it cannot receive", () =>
    Effect.gen(function* () {
      const { endpoint } = yield* serve(true)
      const mcp = yield* McpClient
      const listed = yield* mcp.listEvents(server(endpoint), Option.none())
      const withTools = yield* mcp.listTools(server(endpoint), Option.none())
      expect(listed).toEqual([
        {
          name: "ticket.created",
          description: "A ticket was opened",
          delivery: ["poll", "webhook"],
          inputSchema: created.inputSchema,
          payloadSchema: created.payloadSchema
        },
        { name: "ticket.closed", description: "", delivery: ["push"] }
      ])
      expect(withTools.eventTypes).toEqual(Option.some(listed))
      // A listing that never ends fails rather than pass off its first pages as the whole, which would replace the
      // stored listing with a partial one.
      const endless = yield* serve(true, true)
      const cutShort = yield* Effect.flip(mcp.listEvents(server(endless.endpoint), Option.none()))
      expect(cutShort).toMatchObject({ _tag: "McpError", reason: "protocol" })
    }).pipe(Effect.provide(services))
  )

  it.live("polls from now, drains a backlog the server says is waiting, and reports a gap", () =>
    Effect.gen(function* () {
      const { endpoint, seen } = yield* serve(true)
      const mcp = yield* McpClient
      const poll = (cursor: string | null, maxEvents?: number) =>
        mcp.pollEvents(server(endpoint), Option.none(), {
          name: "ticket.created",
          arguments: { queue: "support" },
          cursor,
          ...whenPresent("maxEvents", maxEvents)
        })
      const start = yield* poll(null)
      const first = yield* poll(start.cursor, 1)
      const rest = yield* poll(first.cursor)
      const stale = yield* poll("c-expired")
      expect(start).toEqual({ events: [], cursor: "c0", truncated: false, hasMore: false })
      expect(first).toEqual({
        events: [
          {
            eventId: "evt_1",
            name: "ticket.created",
            timestamp: "2026-11-13T10:00:00Z",
            data: { ticketId: "evt_1" },
            meta: { trace: "evt_1" }
          }
        ],
        cursor: "c1",
        truncated: false,
        hasMore: true,
        nextPollMs: 0
      })
      expect(rest.events.map((event) => event.eventId)).toEqual(["evt_2"])
      expect({ cursor: rest.cursor, hasMore: rest.hasMore }).toEqual({ cursor: "c2", hasMore: false })
      expect(stale).toEqual({ events: [], cursor: "c9", truncated: true, hasMore: false, nextPollMs: 30000 })
      // Every poll carries the whole subscription and the routing header the extension requires.
      expect(seen[0]).toEqual({
        method: "events/poll",
        params: expect.objectContaining({ name: "ticket.created", arguments: { queue: "support" }, cursor: null }),
        mcpName: "ticket.created"
      })
    }).pipe(Effect.provide(services))
  )

  it.live("tells an unknown event type and bad arguments apart from other failures", () =>
    Effect.gen(function* () {
      const { endpoint, seen } = yield* serve(true)
      const mcp = yield* McpClient
      // A tab is a control character, so the name travels base64-encoded in the routing header.
      const unknown = yield* Effect.flip(
        mcp.pollEvents(server(endpoint), Option.none(), { name: "ticket\tvanished", cursor: null })
      )
      const invalid = yield* Effect.flip(
        mcp.pollEvents(server(endpoint), Option.none(), { name: "ticket.created", cursor: "c0", maxEvents: 5 })
      )
      expect(unknown).toMatchObject({
        _tag: "EventsRefused",
        method: "events/poll",
        refusal: "not_found",
        code: -32023,
        data: { kind: "event" }
      })
      expect(invalid).toMatchObject({ _tag: "EventsRefused", refusal: "invalid_params", code: -32602 })
      expect(seen[0]?.mcpName).toBe(`=?base64?${btoa("ticket\tvanished")}?=`)
    }).pipe(Effect.provide(services))
  )

  it.live("subscribes a webhook, refreshes it under the same key, and unsubscribes it once", () =>
    Effect.gen(function* () {
      const { endpoint, seen } = yield* serve(true)
      const mcp = yield* McpClient
      const subscription = {
        name: "ticket.created",
        arguments: { queue: "support" },
        url: hook,
        secret,
        cursor: null
      }
      const made = yield* mcp.subscribeEvents(server(endpoint), Option.none(), { ...subscription, ttlMs: 3_600_000 })
      const refreshed = yield* mcp.subscribeEvents(server(endpoint), Option.none(), {
        ...subscription,
        cursor: made.cursor
      })
      const forever = yield* mcp.subscribeEvents(server(endpoint), Option.none(), {
        ...subscription,
        url: `${hook}/forever`,
        ttlMs: null
      })
      const plain = yield* mcp
        .subscribeEvents(server(endpoint), Option.none(), { ...subscription, url: "http://x" })
        .pipe(Effect.flip)
      const unsubscribe = { name: "ticket.created", arguments: { queue: "support" }, url: hook }
      yield* mcp.unsubscribeEvents(server(endpoint), Option.none(), unsubscribe)
      const again = yield* Effect.flip(mcp.unsubscribeEvents(server(endpoint), Option.none(), unsubscribe))

      expect(made).toEqual({ id: "sub_tickets", refreshBefore: "2026-11-13T11:00:00Z", cursor: "c0", truncated: false })
      expect(refreshed).toEqual({
        id: "sub_tickets",
        refreshBefore: "2026-11-13T11:00:00Z",
        cursor: "c2",
        truncated: false,
        deliveryStatus: { active: true, lastDeliveryAt: null, lastError: null }
      })
      expect(forever.refreshBefore).toBeNull()
      expect(plain).toMatchObject({ _tag: "EventsRefused", refusal: "invalid_params" })
      expect(again).toMatchObject({ _tag: "EventsRefused", refusal: "not_found", data: { kind: "subscription" } })

      const subscribes = seen.filter((request) => request.method === "events/subscribe")
      expect(subscribes[0]?.params).toEqual(
        expect.objectContaining({
          name: "ticket.created",
          arguments: { queue: "support" },
          delivery: { mode: "webhook", url: hook, secret },
          cursor: null,
          ttlMs: 3_600_000
        })
      )
      // Left out, the server picks the lifetime; null asks it for none.
      expect(property(subscribes[1]?.params ?? null, "ttlMs")).toBeNull()
      expect(Object.keys(subscribes[1]?.params ?? {})).not.toContain("ttlMs")
      expect(property(subscribes[2]?.params ?? null, "ttlMs")).toBeNull()
      expect(Object.keys(subscribes[2]?.params ?? {})).toContain("ttlMs")
      expect(seen.find((request) => request.method === "events/unsubscribe")).toEqual({
        method: "events/unsubscribe",
        params: expect.objectContaining({
          name: "ticket.created",
          arguments: { queue: "support" },
          delivery: { url: hook }
        }),
        mcpName: "ticket.created"
      })
    }).pipe(Effect.provide(services))
  )

  it.live("declares the extension on every request, and sends none of its methods to a server without it", () =>
    Effect.gen(function* () {
      const offering = yield* serve(true)
      const plain = yield* serve(false)
      const mcp = yield* McpClient
      yield* mcp.listEvents(server(offering.endpoint), Option.none())
      const listed = yield* mcp.listEvents(server(plain.endpoint), Option.none())
      const listing = yield* mcp.listTools(server(plain.endpoint), Option.none())
      const polled = yield* Effect.flip(
        mcp.pollEvents(server(plain.endpoint), Option.none(), { name: "ticket.created", cursor: null })
      )
      const declared = property(
        property(property(offering.seen[0]?.params ?? null, "_meta"), "io.modelcontextprotocol/clientCapabilities"),
        "extensions"
      )
      expect(property(declared, mcpEventsExtension)).toEqual({})
      expect({ listed, eventTypes: listing.eventTypes, sent: plain.seen }).toEqual({
        listed: [],
        eventTypes: Option.some([]),
        sent: []
      })
      expect(polled).toMatchObject({ _tag: "EventsRefused", refusal: "unsupported" })
    }).pipe(Effect.provide(services))
  )
})
