import { afterEach, describe, expect, it } from "bun:test"
import { Effect, Option } from "effect"
import { McpHost } from "../../../src/mcp/client.ts"

const servers: Array<ReturnType<typeof Bun.serve>> = []

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true)
})

const malformedServer = (response: () => Response): string => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: response
  })
  servers.push(server)
  return `http://127.0.0.1:${server.port}/mcp`
}

describe("malformed MCP servers", () => {
  it("rejects a non-JSON initialize response", async () => {
    const endpoint = malformedServer(() => new Response("not json", {
      headers: { "content-type": "application/json" }
    }))
    const result = await Effect.runPromiseExit(
      Effect.flatMap(McpHost, (host) => host.listTools(endpoint, Option.none())).pipe(
        Effect.provide(McpHost.layer)
      )
    )
    expect(result._tag).toBe("Failure")
  })

  it("rejects an invalid JSON-RPC envelope", async () => {
    const endpoint = malformedServer(() => Response.json({ result: { tools: [] } }))
    const result = await Effect.runPromiseExit(
      Effect.flatMap(McpHost, (host) => host.listTools(endpoint, Option.none())).pipe(
        Effect.provide(McpHost.layer)
      )
    )
    expect(result._tag).toBe("Failure")
  })
})
