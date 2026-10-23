import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { FetchHttpClient } from "effect/http"
import { searchIntegrations } from "../src/registry.ts"

describe("integration registry", () => {
  it.effect("browses with an empty query and uses search result endpoints", () =>
    Effect.gen(function* () {
      const paths: Array<string> = []
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          const url = new URL(request.url)
          paths.push(url.pathname + url.search)
          return Response.json({
            results: [
              {
                domain: "example.com",
                name: "Example",
                description: "Example integration",
                surfaces: [
                  { kind: "mcp", slug: "example-mcp", url: "https://example.com/mcp" },
                  { kind: "openapi", slug: "example-api", url: "https://example.com/openapi.json" }
                ]
              },
              {
                domain: "nothing.example",
                name: "nothing.example",
                description: "No developer endpoints found"
              }
            ]
          })
        }
      })
      try {
        const response = yield* searchIntegrations(
          { q: "", limit: 100 },
          { registryUrl: `http://127.0.0.1:${server.port}` }
        ).pipe(Effect.provide(FetchHttpClient.layer))

        expect(paths).toEqual(["/api/search?q=&limit=100"])
        expect(response.results.map((result) => result.domain)).toEqual(["example.com"])
        expect(response.results[0]?.surfaces).toEqual([
          { type: "mcp", slug: "example-mcp", name: "MCP", url: "https://example.com/mcp" },
          { type: "openapi", slug: "example-api", name: "OpenAPI", url: "https://example.com/openapi.json" }
        ])
      } finally {
        server.stop()
      }
    })
  )

  it.effect("tells a registry that is down apart from a query it refused", () =>
    Effect.gen(function* () {
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => new Response("upstream down", { status: 503 })
      })
      try {
        const registryUrl = `http://127.0.0.1:${server.port}`
        const down = yield* Effect.flip(searchIntegrations({ q: "linear", limit: 5 }, { registryUrl }))
        const malformed = yield* Effect.flip(searchIntegrations({ q: " linear", limit: 5 }, { registryUrl }))

        expect(down).toMatchObject({ _tag: "RegistryUnavailable", reason: "status", status: 503, retryable: true })
        expect(malformed).toMatchObject({ _tag: "InvalidInput", field: "query", retryable: false })
      } finally {
        server.stop()
      }
    }).pipe(Effect.provide(FetchHttpClient.layer))
  )
})
