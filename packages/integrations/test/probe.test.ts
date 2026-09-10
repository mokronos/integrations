import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Option, Schema, Scope } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { McpClient } from "../src/mcp/client.ts"

const JsonRpcRequest = Schema.Struct({
  id: Schema.optional(Schema.Union([Schema.Number, Schema.String])),
  method: Schema.String
})

const tool = {
  name: "list_labels",
  description: "Lists labels.",
  inputSchema: { type: "object", properties: {} }
}

/** A stateless MCP endpoint, stopped when the test's scope ends. */
const startServer = (options: {
  readonly publishes: boolean
  readonly scopes?: ReadonlyArray<string>
}): Effect.Effect<string, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const server: ReturnType<typeof Bun.serve> = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        async fetch(request): Promise<Response> {
          const url = new URL(request.url)
          const origin = `http://127.0.0.1:${server.port}`

          if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
            if (!options.publishes) return new Response("not found", { status: 404 })
            return Response.json({
              resource: `${origin}/mcp`,
              authorization_servers: [origin],
              bearer_methods_supported: ["header"],
              scopes_supported: options.scopes ?? []
            })
          }

          if (url.pathname.startsWith("/.well-known/oauth-authorization-server")) {
            if (!options.publishes) return new Response("not found", { status: 404 })
            return Response.json({
              issuer: origin,
              authorization_endpoint: `${origin}/authorize`,
              token_endpoint: `${origin}/token`,
              response_types_supported: ["code"],
              code_challenge_methods_supported: ["S256"]
            })
          }

          if (url.pathname !== "/mcp") return new Response("not found", { status: 404 })
          if (request.method !== "POST") return new Response(null, { status: 405 })

          const decoded = Schema.decodeUnknownOption(JsonRpcRequest)(await request.json())
          if (Option.isNone(decoded)) return new Response(null, { status: 202 })
          const body = decoded.value
          if (body.method === "server/discover") {
            return Response.json({
              jsonrpc: "2.0",
              id: body.id,
              result: {
                resultType: "complete",
                ttlMs: 0,
                cacheScope: "private",
                supportedVersions: ["2026-07-28"],
                capabilities: { tools: { listChanged: false } },
                _meta: {
                  "io.modelcontextprotocol/serverInfo": { name: "StatelessServer", version: "1" }
                }
              }
            })
          }
          if (body.method === "tools/list") {
            return Response.json({
              jsonrpc: "2.0",
              id: body.id,
              result: { resultType: "complete", ttlMs: 0, cacheScope: "private", tools: [tool] }
            })
          }
          return new Response(null, { status: 202 })
        }
        })
      return server
    }),
    (server) => Effect.promise(() => server.stop(true))
  ).pipe(Effect.map((server) => `http://127.0.0.1:${server.port}/mcp`))

const probe = (endpoint: string) =>
  Effect.flatMap(McpClient, (mcp) => mcp.probe(endpoint))

const services = McpClient.layer.pipe(Layer.provide(FetchHttpClient.layer))

describe("probing an MCP endpoint", () => {
  it.live("requires auth when the endpoint declares an authority, however it answers", () =>
    Effect.gen(function*() {
      const scope = "https://www.googleapis.com/auth/gmail.readonly"

      const found = yield* probe(yield* startServer({ publishes: true, scopes: [scope] }))

      expect(found.connected).toBe(true)
      expect(found.toolCount).toBe(1)
      expect(found.serverName).toBe("StatelessServer")
      expect(found.requiresAuthentication).toBe(true)
      expect(found.requiresOAuth).toBe(true)
      expect(found.scopes).toEqual([scope])
      expect(found.supportsDynamicRegistration).toBe(false)
    }).pipe(Effect.provide(services)))

  it.live("asks for nothing when the endpoint declares no authority", () =>
    Effect.gen(function*() {
      const found = yield* probe(yield* startServer({ publishes: false }))

      expect(found.connected).toBe(true)
      expect(found.requiresAuthentication).toBe(false)
      expect(found.requiresOAuth).toBe(false)
      expect(found.scopes).toEqual([])
    }).pipe(Effect.provide(services)))
})
