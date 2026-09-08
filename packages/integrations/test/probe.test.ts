import { afterEach, describe, expect, it } from "bun:test"
import { Effect, Layer, Option, Schema } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { McpHost } from "../src/mcp/client.ts"

const servers: Array<ReturnType<typeof Bun.serve>> = []

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true)
})

const JsonRpcRequest = Schema.Struct({
  id: Schema.optional(Schema.Union([Schema.Number, Schema.String])),
  method: Schema.String
})

const tool = {
  name: "list_labels",
  description: "Lists labels.",
  inputSchema: { type: "object", properties: {} }
}

const startServer = (options: {
  readonly publishes: boolean
  readonly scopes?: ReadonlyArray<string>
}) => {
  const server = Bun.serve({
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
  servers.push(server)
  return `http://127.0.0.1:${server.port}/mcp`
}

const probe = (endpoint: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const mcp = yield* McpHost
      return yield* mcp.probe(endpoint)
    }).pipe(Effect.provide(McpHost.layer.pipe(Layer.provide(FetchHttpClient.layer))))
  )

describe("probing an MCP endpoint", () => {
  it("requires auth when the endpoint declares an authority, however it answers", async () => {
    const scope = "https://www.googleapis.com/auth/gmail.readonly"
    const found = await probe(startServer({ publishes: true, scopes: [scope] }))

    expect(found.connected).toBe(true)
    expect(found.toolCount).toBe(1)
    expect(found.serverName).toBe("StatelessServer")
    expect(found.requiresAuthentication).toBe(true)
    expect(found.requiresOAuth).toBe(true)
    expect(found.scopes).toEqual([scope])
    expect(found.supportsDynamicRegistration).toBe(false)
  })

  it("asks for nothing when the endpoint declares no authority", async () => {
    const found = await probe(startServer({ publishes: false }))
    expect(found.connected).toBe(true)
    expect(found.requiresAuthentication).toBe(false)
    expect(found.requiresOAuth).toBe(false)
    expect(found.scopes).toEqual([])
  })
})
