import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Option, Scope } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { McpClient } from "../../../src/mcp/client.ts"

const services = McpClient.layer.pipe(Layer.provide(FetchHttpClient.layer))

/** An endpoint that answers every request the same wrong way. */
const malformedServer = (
  response: () => Response
): Effect.Effect<string, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: response })),
    (server) => Effect.promise(() => server.stop(true))
  ).pipe(Effect.map((server) => `http://127.0.0.1:${server.port}/mcp`))

const listTools = (endpoint: string) =>
  Effect.flatMap(McpClient, (host) => host.listTools(endpoint, Option.none()))

describe("malformed MCP servers", () => {
  it.live("rejects a non-JSON initialize response", () =>
    Effect.gen(function*() {
      const endpoint = yield* malformedServer(() =>
        new Response("not json", { headers: { "content-type": "application/json" } }))

      expect((yield* Effect.exit(listTools(endpoint)))._tag).toBe("Failure")
    }).pipe(Effect.provide(services)))

  it.live("rejects an invalid JSON-RPC envelope", () =>
    Effect.gen(function*() {
      const endpoint = yield* malformedServer(() => Response.json({ result: { tools: [] } }))

      expect((yield* Effect.exit(listTools(endpoint)))._tag).toBe("Failure")
    }).pipe(Effect.provide(services)))
})
