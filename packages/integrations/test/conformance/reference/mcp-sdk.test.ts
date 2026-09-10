import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Option } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { McpClient } from "../../../src/mcp/client.ts"
import { verifyMcpConformance } from "../support/mcp-conformance.ts"
import { referenceMcpServer } from "../support/reference-mcp.ts"

const services = McpClient.layer.pipe(Layer.provide(FetchHttpClient.layer))

describe("official MCP SDK reference server", () => {
  it.live("passes the MCP client conformance contract", () =>
    Effect.gen(function*() {
      const endpoint = yield* referenceMcpServer

      yield* verifyMcpConformance({
        endpoint,
        credential: Option.none(),
        expectedTool: "reference_status",
        input: {},
        assertResult: (result) => {
          expect(result).toEqual({
            content: [{ type: "text", text: "ready" }],
            structuredContent: { status: "ready", implementation: "official-sdk" },
            _meta: {
              "io.modelcontextprotocol/serverInfo": {
                name: "official-sdk-reference",
                version: "1.0.0"
              }
            }
          })
        }
      })
    }).pipe(Effect.provide(services)))

  it.live("is identified through a real SDK handshake", () =>
    Effect.gen(function*() {
      const endpoint = yield* referenceMcpServer

      const probe = yield* Effect.flatMap(McpClient, (host) => host.probe(endpoint))

      expect(probe.connected).toBe(true)
      expect(probe.serverName).toBe("official-sdk-reference")
      expect(probe.toolCount).toBe(1)
    }).pipe(Effect.provide(services)))
})
