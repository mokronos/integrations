import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Layer, Option, Schema } from "effect"
import type { Scope } from "effect"
import { Egress } from "../src/egress/egress.ts"
import { defaultUrlPolicy } from "../src/egress/url-policy.ts"
import { McpError } from "../src/errors.ts"
import { McpClient } from "../src/mcp/client.ts"

const JsonRpcRequest = Schema.Struct({
  id: Schema.optional(Schema.Union([Schema.Number, Schema.String])),
  method: Schema.String,
  params: Schema.optional(Schema.Struct({ protocolVersion: Schema.optional(Schema.String) }))
})
type JsonRpcRequest = typeof JsonRpcRequest.Type
const decodeRequest = Schema.decodeUnknownOption(Schema.fromJsonString(JsonRpcRequest))

const tool = { name: "create_payment", inputSchema: { type: "object", properties: {} } }

const complete = { resultType: "complete", ttlMs: 0, cacheScope: "private" }

const modernAnswer = (request: JsonRpcRequest, callTool: (id: JsonRpcRequest["id"]) => Response): Response => {
  switch (request.method) {
    case "server/discover":
      return Response.json({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          ...complete,
          supportedVersions: ["2026-07-28"],
          capabilities: { tools: { listChanged: false } },
          _meta: { "io.modelcontextprotocol/serverInfo": { name: "Payments", version: "1" } }
        }
      })
    case "tools/list":
      return Response.json({ jsonrpc: "2.0", id: request.id, result: { ...complete, tools: [tool] } })
    case "tools/call":
      return callTool(request.id)
    default:
      return new Response(null, { status: 202 })
  }
}

interface Fixture {
  readonly endpoint: string
  readonly userAgents: ReadonlyArray<string | null>
  readonly toolCalls: () => number
}

const serve = (
  handle: (request: Request, body: Option.Option<JsonRpcRequest>, origin: string) => Response | Promise<Response>
): Effect.Effect<Fixture, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const userAgents: Array<string | null> = []
      let calls = 0
      const server: ReturnType<typeof Bun.serve> = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        idleTimeout: 0,
        async fetch(request) {
          if (!new URL(request.url).pathname.startsWith("/.well-known/")) {
            userAgents.push(request.headers.get("user-agent"))
          }
          const body = request.method === "POST" ? decodeRequest(await request.text()) : Option.none()
          if (Option.exists(body, (found) => found.method === "tools/call")) calls++
          return handle(request, body, `http://127.0.0.1:${server.port}`)
        }
      })
      return { server, userAgents, toolCalls: () => calls }
    }),
    ({ server }) => Effect.promise(() => server.stop(true))
  ).pipe(
    Effect.map(({ server, userAgents, toolCalls }) => ({
      endpoint: `http://127.0.0.1:${server.port}/mcp`,
      userAgents,
      toolCalls
    }))
  )

/** Answers every POST the same way. */
const answering = (response: () => Response) => serve(() => response())

/** A modern endpoint whose tools/call answer is `callTool`. */
const modern = (callTool: (id: JsonRpcRequest["id"]) => Response) =>
  serve((request, body) =>
    request.method !== "POST" || Option.isNone(body)
      ? new Response(null, { status: request.method === "POST" ? 202 : 405 })
      : modernAnswer(body.value, callTool)
  )

/**
 * A server that only speaks the 2024-11-05 HTTP+SSE transport: POST to the
 * endpoint is 404, GET opens the event stream, and answers arrive on it.
 */
const legacySse = serve(
  (() => {
    const encoder = new TextEncoder()
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined
    const send = (event: string, data: string) => stream?.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`))
    return (request: Request, body: Option.Option<JsonRpcRequest>) => {
      const url = new URL(request.url)
      if (url.pathname === "/mcp" && request.method === "GET") {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              stream = controller
              send("endpoint", "/messages")
            }
          }),
          { headers: { "content-type": "text/event-stream" } }
        )
      }
      if (url.pathname !== "/messages" || Option.isNone(body)) return new Response("not found", { status: 404 })
      const message = body.value
      const result =
        message.method === "initialize"
          ? {
              protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: "LegacySse", version: "1" }
            }
          : message.method === "tools/list"
            ? { tools: [tool] }
            : message.method === "tools/call"
              ? { content: [{ type: "text", text: "paid" }] }
              : undefined
      if (message.id !== undefined && result !== undefined) {
        send("message", JSON.stringify({ jsonrpc: "2.0", id: message.id, result }))
      }
      return new Response(null, { status: 202 })
    }
  })()
)

const services = McpClient.layer.pipe(Layer.provide(Egress.layer(defaultUrlPolicy)))

const server = (endpoint: string) => ({ endpoint, era: Option.none() })

const listTools = (endpoint: string) =>
  Effect.flatMap(McpClient, (mcp) => mcp.listTools(server(endpoint), Option.none()))

const callTool = (endpoint: string) =>
  Effect.flatMap(McpClient, (mcp) => mcp.callTool(server(endpoint), Option.none(), "create_payment", {}))

const failureOf = <A>(effect: Effect.Effect<A, McpError, McpClient>) =>
  Effect.flatMap(Effect.exit(effect), (exit) =>
    Exit.isFailure(exit) && exit.cause.reasons[0]?._tag === "Fail" && exit.cause.reasons[0].error instanceof McpError
      ? Effect.succeed(exit.cause.reasons[0].error)
      : Effect.die(new Error("expected an McpError"))
  )

describe("MCP upstream failures", () => {
  it.live("names the reason an HTTP status gives, and nothing from the body", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<readonly [() => Response, McpError["reason"]]> = [
        [() => new Response("secret body", { status: 401 }), "unauthorized"],
        [() => new Response("slow down", { status: 429 }), "rate_limited"],
        [() => new Response("slow down", { status: 403, headers: { "retry-after": "30" } }), "rate_limited"],
        [
          () =>
            new Response("no", {
              status: 403,
              headers: { "www-authenticate": 'Bearer error="insufficient_scope", scope="payments"' }
            }),
          "forbidden"
        ],
        [() => new Response("<html>boom</html>", { status: 502 }), "unavailable"]
      ]
      for (const [response, reason] of cases) {
        const { endpoint } = yield* answering(response)
        const failed = yield* failureOf(listTools(endpoint))
        expect(failed.reason).toBe(reason)
        expect(failed.detail).not.toMatch(/secret|slow down|boom|no$/)
      }
    }).pipe(Effect.provide(services))
  )

  it.live("hands a JSON-RPC refusal of tools/call back as the tool's own error", () =>
    Effect.gen(function* () {
      const { endpoint } = yield* modern((id) =>
        Response.json({
          jsonrpc: "2.0",
          id,
          error: { code: -32602, message: "currency must be one of: usd, eur" }
        })
      )

      expect(yield* callTool(endpoint)).toEqual({
        kind: "complete",
        result: { content: [{ type: "text", text: "currency must be one of: usd, eur" }], isError: true },
        declined: []
      })
    }).pipe(Effect.provide(services))
  )

  it.live("hands a 4xx JSON refusal of tools/call back as the tool's own error", () =>
    Effect.gen(function* () {
      const { endpoint } = yield* modern(() =>
        Response.json({ error: { message: "stripe_context is required" } }, { status: 422 })
      )

      expect(yield* callTool(endpoint)).toEqual({
        kind: "complete",
        result: { content: [{ type: "text", text: "stripe_context is required" }], isError: true },
        declined: []
      })
    }).pipe(Effect.provide(services))
  )

  it.live("falls back to HTTP+SSE when Streamable HTTP is not served, calling the tool once", () =>
    Effect.gen(function* () {
      const fixture = yield* legacySse

      const listing = yield* listTools(fixture.endpoint)
      expect(listing.era).toBe("legacy")
      expect(listing.tools.map((found) => found.name)).toEqual(["create_payment"])

      expect(yield* callTool(fixture.endpoint)).toEqual({
        kind: "complete",
        result: { content: [{ type: "text", text: "paid" }] },
        declined: []
      })
      expect(fixture.toolCalls()).toBe(1)
    }).pipe(Effect.provide(services))
  )

  it.live("sends a User-Agent on the probe and every session request", () =>
    Effect.gen(function* () {
      const fixture = yield* modern((id) => Response.json({ jsonrpc: "2.0", id, result: { ...complete, content: [] } }))

      yield* Effect.flatMap(McpClient, (mcp) => mcp.probe(fixture.endpoint))
      yield* callTool(fixture.endpoint)

      expect(fixture.userAgents.length).toBeGreaterThan(1)
      expect(new Set(fixture.userAgents)).toEqual(new Set(["integrations-gateway"]))
    }).pipe(Effect.provide(services))
  )

  it.live("reports an unreachable server by host only", () =>
    Effect.gen(function* () {
      const closed = yield* Effect.acquireRelease(
        Effect.sync(() => Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })),
        (running) => Effect.promise(() => running.stop(true))
      )
      const port = closed.port
      yield* Effect.promise(() => closed.stop(true))
      const unreachable = `http://127.0.0.1:${port}/mcp?token=secret`

      const failed = yield* failureOf(listTools(unreachable))

      expect(failed.reason).toBe("network")
      expect(failed.detail).toBe(`could not reach 127.0.0.1:${port}`)
    }).pipe(Effect.provide(services))
  )
})
