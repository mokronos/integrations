import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { Effect, Option } from "effect"
import { McpHost } from "../../../src/mcp/client.ts"
import { verifyMcpConformance } from "../support/mcp-conformance.ts"
import {
  startReferenceMcpServer,
  type ReferenceMcpServer
} from "../support/reference-mcp.ts"

describe("official MCP SDK reference server", () => {
  let reference: ReferenceMcpServer

  beforeAll(async () => {
    reference = await startReferenceMcpServer()
  })

  afterAll(async () => {
    await reference.stop()
  })

  it("passes the MCP client conformance contract", async () => {
    await Effect.runPromise(verifyMcpConformance({
      endpoint: reference.endpoint,
      credential: Option.none(),
      expectedTool: "reference_status",
      input: {},
      assertResult: (result) => {
        expect(result).toEqual({
          content: [{ type: "text", text: "ready" }],
          structuredContent: { status: "ready", implementation: "official-sdk" }
        })
      }
    }).pipe(Effect.provide(McpHost.layer)))
  })

  it("is identified through a real SDK handshake", async () => {
    const probe = await Effect.runPromise(
      Effect.flatMap(McpHost, (host) => host.probe(reference.endpoint)).pipe(
        Effect.provide(McpHost.layer)
      )
    )
    expect(probe.connected).toBe(true)
    expect(probe.serverName).toBe("official-sdk-reference")
    expect(probe.toolCount).toBe(1)
  })
})

