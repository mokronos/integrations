import { expect } from "@effect/vitest"
import { Effect, Option } from "effect"
import type { Json } from "@integrations/contracts"
import { McpClient, type McpCredential } from "../../../src/mcp/client.ts"

export interface McpConformanceTarget {
  readonly endpoint: string
  readonly credential: Option.Option<McpCredential>
  readonly expectedTool: string
  readonly input: Json
  readonly assertResult: (result: Json) => void
}

export const verifyMcpConformance = (
  target: McpConformanceTarget
): Effect.Effect<void, Error, McpClient> =>
  Effect.gen(function*() {
    const host = yield* McpClient
    const tools = yield* host.listTools(target.endpoint, target.credential)
    const names = tools.map((tool) => tool.name)

    expect(new Set(names).size).toBe(names.length)
    expect(names).toContain(target.expectedTool)

    const tool = tools.find((candidate) => candidate.name === target.expectedTool)
    expect(tool?.description?.length).toBeGreaterThan(0)
    expect(tool?.inputSchema).toBeDefined()

    const result = yield* host.callTool(
      target.endpoint,
      target.credential,
      target.expectedTool,
      target.input
    )
    target.assertResult(result)
  })

