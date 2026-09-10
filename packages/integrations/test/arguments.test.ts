import { expect, it } from "@effect/vitest"
import { Context, Effect, Layer, Option } from "effect"
import { ConnectionName, IntegrationSlug } from "@integrations/contracts"
import { captureOpenApiTools } from "../src/catalog/capture.ts"
import type { HttpCall } from "../src/tool.ts"
import { missingArguments, splitArguments } from "../src/openapi/arguments.ts"
import { compileSpec } from "../src/openapi/compile.ts"

const document = JSON.stringify({
  openapi: "3.0.3",
  info: { title: "Example", version: "1" },
  servers: [{ url: "https://example.com" }],
  paths: {
    "/trees/{treeId}/nodes": {
      get: {
        operationId: "listNodes",
        parameters: [
          { name: "treeId", in: "path", required: true, schema: { type: "string" } },
          { name: "depth", in: "query", schema: { type: "integer" } }
        ],
        responses: { "200": { description: "ok" } }
      },
      post: {
        operationId: "addNode",
        parameters: [
          { name: "treeId", in: "path", required: true, schema: { type: "string" } }
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { type: "object", properties: { label: { type: "string" } } }
            }
          }
        },
        responses: { "201": { description: "created" } }
      }
    }
  }
})

/** The operations this document declares, compiled once for the whole suite. */
class Operations extends Context.Service<Operations, {
  readonly call: (name: string) => HttpCall
}>()("test/Operations") {
  static readonly layer = Layer.effect(Operations, Effect.gen(function*() {
    const spec = yield* compileSpec("https://example.com/openapi.json", document)
    const captured = yield* captureOpenApiTools(
      {
        owner: "org",
        integration: IntegrationSlug.make("example"),
        connection: ConnectionName.make("default")
      },
      spec,
      0
    )
    return {
      call: (name: string) => {
        const found = captured.find((candidate) => candidate.name === name)
        if (found === undefined || found.call.kind !== "http") {
          throw new Error(`no HTTP tool ${name}`)
        }
        return found.call
      }
    }
  }))
}

it.layer(Operations.layer)("splitting a caller's arguments", (it) => {
  it.effect("routes each property to the location the operation declared", () =>
    Effect.gen(function*() {
      const { call } = yield* Operations
      const split = splitArguments(call("listNodes"), { treeId: "t1", depth: 3 })
      expect(split.parameters).toEqual({ treeId: "t1", depth: 3 })
      expect(Option.isNone(split.requestBody)).toBe(true)
      expect(split.unknown).toEqual([])
    }))

  it.effect("reports a property the operation does not declare instead of forwarding it", () =>
    Effect.gen(function*() {
      const { call } = yield* Operations
      const split = splitArguments(call("listNodes"), { treeId: "t1", invented: "x" })
      expect(split.unknown).toEqual(["invented"])
      expect(split.parameters).toEqual({ treeId: "t1" })
    }))

  it.effect("separates the body from the parameters", () =>
    Effect.gen(function*() {
      const { call } = yield* Operations
      const split = splitArguments(call("addNode"), { treeId: "t1", body: { label: "root" } })
      expect(split.parameters).toEqual({ treeId: "t1" })
      expect(Option.getOrNull(split.requestBody)).toEqual({ label: "root" })
    }))
})

it.layer(Operations.layer)("required arguments", (it) => {
  it.effect("names what is missing, rather than building a broken request", () =>
    Effect.gen(function*() {
      const { call } = yield* Operations
      expect(missingArguments(call("listNodes"), {})).toEqual(["treeId"])
      expect(missingArguments(call("listNodes"), { treeId: "t1" })).toEqual([])
    }))
})
