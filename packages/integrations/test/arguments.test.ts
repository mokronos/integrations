import { describe, expect, it } from "bun:test"
import { Effect, Option } from "effect"
import { ConnectionName, IntegrationSlug } from "@mokronos/contracts"
import { captureOpenApiTools } from "../src/catalog/capture.ts"
import type { HttpCall } from "@mokronos/core-integrations"
import { missingArguments, splitArguments } from "../src/openapi/arguments.ts"
import { compileSpec } from "../src/openapi/compile.ts"

/** Captured exactly as installing would, because that is what a call sees:
 *  the stored descriptor, never the document it came from. */
const spec = await Effect.runPromise(compileSpec(
  "https://example.com/openapi.json",
  JSON.stringify({
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
))

const captured = await Effect.runPromise(captureOpenApiTools(
  {
    owner: "org",
    integration: IntegrationSlug.make("example"),
    connection: ConnectionName.make("default")
  },
  spec,
  0
))

const call = (name: string): HttpCall => {
  const found = captured.find((candidate) => candidate.name === name)
  if (found === undefined || found.call.kind !== "http") {
    throw new Error(`no HTTP tool ${name}`)
  }
  return found.call
}

describe("splitting a caller's arguments", () => {
  it("routes each property to the location the operation declared", () => {
    const split = splitArguments(call("listNodes"), { treeId: "t1", depth: 3 })
    expect(split.parameters).toEqual({ treeId: "t1", depth: 3 })
    expect(Option.isNone(split.requestBody)).toBe(true)
    expect(split.unknown).toEqual([])
  })

  it("reports a property the operation does not declare instead of forwarding it", () => {
    // Forwarding it would default to the query string, turning a caller's typo
    // into a filter nobody asked for.
    const split = splitArguments(call("listNodes"), { treeId: "t1", invented: "x" })
    expect(split.unknown).toEqual(["invented"])
    expect(split.parameters).toEqual({ treeId: "t1" })
  })

  it("separates the body from the parameters", () => {
    const split = splitArguments(call("addNode"), { treeId: "t1", body: { label: "root" } })
    expect(split.parameters).toEqual({ treeId: "t1" })
    expect(Option.getOrNull(split.requestBody)).toEqual({ label: "root" })
  })
})

describe("required arguments", () => {
  it("names what is missing, rather than building a broken request", () => {
    expect(missingArguments(call("listNodes"), {})).toEqual(["treeId"])
    expect(missingArguments(call("listNodes"), { treeId: "t1" })).toEqual([])
  })
})
