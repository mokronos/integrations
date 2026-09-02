import { describe, expect, it } from "bun:test"
import { Effect, Option } from "effect"
import { isJsonObject } from "@mokronos/contracts"
import { McpHost } from "../../../src/mcp/client.ts"
import { verifyMcpConformance } from "../support/mcp-conformance.ts"

const enabled = process.env["RUN_REMOTE_INTEGRATION_TESTS"] === "1"
const remoteDescribe = enabled ? describe : describe.skip

remoteDescribe("remote MCP conformance", () => {
  const githubToken = process.env["INTEGRATIONS_TEST_GITHUB_TOKEN"]?.trim() || undefined
  const githubIt = githubToken === undefined ? it.skip : it

  githubIt("GitHub's hosted MCP server", async () => {
    await Effect.runPromise(verifyMcpConformance({
      endpoint: "https://api.githubcopilot.com/mcp/",
      credential: Option.some({
        headerName: "Authorization",
        headerValue: `Bearer ${githubToken}`
      }),
      expectedTool: "get_me",
      input: {},
      assertResult: (result) => {
        expect(isJsonObject(result)).toBe(true)
        expect(Array.isArray(isJsonObject(result) ? result["content"] : undefined)).toBe(true)
      }
    }).pipe(Effect.provide(McpHost.layer)))
  })

  const ownedEndpoint = process.env["INTEGRATIONS_TEST_MCP_URL"]?.trim() || undefined
  const ownedIt = ownedEndpoint === undefined ? it.skip : it

  ownedIt("the project-owned authless MCP reference deployment", async () => {
    await Effect.runPromise(verifyMcpConformance({
      endpoint: ownedEndpoint ?? "",
      credential: Option.none(),
      expectedTool: "reference_status",
      input: {},
      assertResult: (result) => {
        expect(isJsonObject(result)).toBe(true)
      }
    }).pipe(Effect.provide(McpHost.layer)))
  })
})
