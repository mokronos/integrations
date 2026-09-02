import { afterEach, describe, expect, it } from "bun:test"
import { Effect, Option, Schema } from "effect"
import { McpHost } from "../src/mcp/client.ts"

/** How an MCP endpoint answers the two questions a probe asks: can anybody
 *  reach it, and does it name an authority.
 *
 *  These run against a real server on a real port rather than a stub, because
 *  what is under test is a conversation — the JSON-RPC handshake, the RFC 9728
 *  lookup, and the RFC 8414 hop after it — and a stub of that conversation would
 *  only ever agree with whatever this file already believes. */

const servers: Array<ReturnType<typeof Bun.serve>> = []

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true)
})

/** Only what this server dispatches on. The transport also sends notifications,
 *  which carry no id and need no answer. */
const JsonRpcRequest = Schema.Struct({
  id: Schema.optional(Schema.Number),
  method: Schema.String
})

const tool = {
  name: "list_labels",
  description: "Lists labels.",
  inputSchema: { type: "object", properties: {} }
}

/** A stateless MCP server that talks to anybody, in the shape of the servers
 *  that prompted this: `initialize` and `tools/list` are open, and `publishes`
 *  decides whether it also declares an authorization server for the calls it
 *  would refuse. */
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
          // No `registration_endpoint`, like every provider that makes an
          // operator create the client by hand.
          code_challenge_methods_supported: ["S256"]
        })
      }

      if (url.pathname !== "/mcp") return new Response("not found", { status: 404 })
      // Streamable HTTP opens a GET stream when the server allows one, and this
      // one does not: everything it has to say fits in the POST responses.
      if (request.method !== "POST") return new Response(null, { status: 405 })

      const decoded = Schema.decodeUnknownOption(JsonRpcRequest)(await request.json())
      if (Option.isNone(decoded)) return new Response(null, { status: 202 })
      const body = decoded.value
      if (body.method === "initialize") {
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "StatelessServer", version: "1" }
          }
        })
      }
      if (body.method === "tools/list") {
        return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools: [tool] } })
      }
      // `notifications/initialized` and anything else without an id.
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
    }).pipe(Effect.provide(McpHost.layer))
  )

describe("probing an MCP endpoint", () => {
  it("requires auth when the endpoint declares an authority, however it answers", async () => {
    const scope = "https://www.googleapis.com/auth/gmail.readonly"
    const found = await probe(startServer({ publishes: true, scopes: [scope] }))

    // Reachable and usable are different answers. The handshake succeeded and
    // the tools are readable, and none of them can be called without a token.
    expect(found.connected).toBe(true)
    expect(found.toolCount).toBe(1)
    expect(found.serverName).toBe("StatelessServer")
    expect(found.requiresAuthentication).toBe(true)
    expect(found.requiresOAuth).toBe(true)
    expect(found.scopes).toEqual([scope])
    // The authorization server offers no registration endpoint, so authorizing
    // will need a client the operator made.
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
