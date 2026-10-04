import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { ConnectionName, IntegrationSlug, objectEntries, property } from "@integragents/contracts"
import type { Json } from "@integragents/contracts"
import { captureOpenApiTools } from "../src/catalog/capture.ts"
import { splitArguments } from "../src/openapi/arguments.ts"
import { compileSpec } from "../src/openapi/compile.ts"
import { buildRequest } from "../src/openapi/request.ts"

const compileOne = (server: string, operation: Json, securitySchemes: Json = {}) =>
  Effect.gen(function*() {
    const spec = yield* compileSpec("https://example.com/openapi.json", JSON.stringify({
      openapi: "3.0.3",
      info: { title: "Example", version: "1" },
      servers: [{ url: server }],
      components: { securitySchemes },
      paths: { "/items/{id}": { get: operation } }
    }))
    const [tool] = yield* captureOpenApiTools(
      { owner: "org", integration: IntegrationSlug.make("example"), connection: ConnectionName.make("default") },
      spec,
      0
    )
    if (tool === undefined || tool.call.kind !== "http") return yield* Effect.die("no HTTP tool")
    const call = tool.call
    return {
      arguments: Object.keys(objectEntries(property(tool.inputSchema ?? null, "properties"))),
      build: (input: Record<string, Json>) => {
        const split = splitArguments(call, input)
        return buildRequest({ call, server, parameters: split.parameters, requestBody: split.requestBody })
      }
    }
  })

const parameter = (name: string, location: string): Json =>
  ({ name, in: location, required: location === "path", schema: { type: "string" } })

describe("argument names", () => {
  it.effect("renames what a model cannot accept and sends the declared name", () =>
    Effect.gen(function*() {
      const tool = yield* compileOne("https://api.example.com", {
        parameters: [parameter("id", "path"), parameter("filter[status]", "query")],
        responses: { "200": { description: "ok" } }
      })
      expect(tool.arguments).toEqual(["id", "filter_status_"])
      const url = new URL(tool.build({ id: "1", filter_status_: "open" }).url)
      expect(url.searchParams.get("filter[status]")).toBe("open")
    }))

  it.effect("keeps both parameters when two locations share a name", () =>
    Effect.gen(function*() {
      const tool = yield* compileOne("https://api.example.com", {
        parameters: [parameter("id", "query"), parameter("id", "path")],
        responses: { "200": { description: "ok" } }
      })
      expect(tool.arguments).toEqual(["id", "id_query"])
      expect(tool.build({ id: "p", id_query: "q" }).url).toBe("https://api.example.com/items/p?id=q")
    }))
})

describe("dropped parameters", () => {
  it.effect("drops a parameter that duplicates the credential a scheme carries", () =>
    Effect.gen(function*() {
      const tool = yield* compileOne(
        "https://api.example.com",
        {
          parameters: [parameter("id", "path"), parameter("api_key", "query"), parameter("Authorization", "header")],
          responses: { "200": { description: "ok" } }
        },
        {
          key: { type: "apiKey", in: "query", name: "api_key" },
          bearer: { type: "http", scheme: "bearer" }
        }
      )
      expect(tool.arguments).toEqual(["id"])
    }))

  it.effect("drops Google's system parameters but keeps the ones requests depend on", () =>
    Effect.gen(function*() {
      const parameters = ["$.xgafv", "access_token", "key", "prettyPrint", "alt", "fields", "uploadType"]
        .map((name) => parameter(name, "query"))
      const operation = { parameters: [parameter("id", "path"), ...parameters], responses: { "200": { description: "ok" } } }
      const google = yield* compileOne("https://gmail.googleapis.com/", operation)
      expect(google.arguments).toEqual(["id", "alt", "fields", "uploadType"])
      const other = yield* compileOne("https://api.example.com", operation)
      expect(other.arguments).toEqual(expect.arrayContaining(["_.xgafv", "key"]))
    }))
})
