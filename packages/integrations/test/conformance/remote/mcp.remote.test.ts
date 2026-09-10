import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Option } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { isJsonObject } from "@integrations/contracts"
import { McpClient } from "../../../src/mcp/client.ts"
import { verifyMcpConformance } from "../support/mcp-conformance.ts"

const enabled = process.env["RUN_REMOTE_INTEGRATION_TESTS"] === "1"
const remoteDescribe = enabled ? describe : describe.skip

const services = McpClient.layer.pipe(Layer.provide(FetchHttpClient.layer))

remoteDescribe("remote MCP conformance", () => {
  const githubToken = process.env["INTEGRATIONS_TEST_GITHUB_TOKEN"]?.trim() || undefined

  it.live.runIf(githubToken !== undefined)("GitHub's hosted MCP server", () =>
    verifyMcpConformance({
      endpoint: "https://api.githubcopilot.com/mcp/",
      credential: Option.some({
        headerName: "Authorization",
        headerValue: `Bearer ${githubToken ?? ""}`
      }),
      expectedTool: "get_me",
      input: {},
      assertResult: (result) => {
        expect(isJsonObject(result)).toBe(true)
        expect(Array.isArray(isJsonObject(result) ? result["content"] : undefined)).toBe(true)
      }
    }).pipe(Effect.provide(services)))

  const ownedEndpoint = process.env["INTEGRATIONS_TEST_MCP_URL"]?.trim() || undefined

  it.live.runIf(ownedEndpoint !== undefined)(
    "the project-owned authless MCP reference deployment",
    () =>
      verifyMcpConformance({
        endpoint: ownedEndpoint ?? "",
        credential: Option.none(),
        expectedTool: "reference_status",
        input: {},
        assertResult: (result) => {
          expect(isJsonObject(result)).toBe(true)
        }
      }).pipe(Effect.provide(services))
  )
})
