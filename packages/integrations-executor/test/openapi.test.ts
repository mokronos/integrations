import { describe, expect, it } from "bun:test"
import { Effect, Option } from "effect"
import { compileSpec, previewOf, resolveServer, splitInput } from "../src/openapi.ts"
import { convertGoogleDiscovery, isGoogleDiscoveryUrl } from "../src/google-discovery.ts"
import { isJsonObject, property, type Json } from "../src/json.ts"

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect)

/** A document exercising the parts that are easy to get wrong: a relative
 *  server, a recursive schema, a body behind a `$ref`, and parameters in three
 *  locations. */
const spec = JSON.stringify({
  openapi: "3.0.3",
  info: { title: "Example", version: "2", description: "An example" },
  servers: [{ url: "/api/v2" }],
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer" }
    },
    schemas: {
      Node: {
        type: "object",
        required: ["label"],
        properties: {
          label: { type: "string" },
          // Recursive: dereferencing this document would produce a cycle.
          children: { type: "array", items: { $ref: "#/components/schemas/Node" } }
        }
      },
      Unused: { type: "object", properties: { ignored: { type: "string" } } }
    }
  },
  paths: {
    "/trees/{treeId}/nodes": {
      get: {
        operationId: "listNodes",
        parameters: [
          { name: "treeId", in: "path", required: true, schema: { type: "string" } },
          { name: "depth", in: "query", schema: { type: "integer" } },
          { name: "X-Trace", in: "header", schema: { type: "string" } }
        ],
        responses: {
          "200": {
            description: "ok",
            content: {
              "application/json": {
                schema: { type: "array", items: { $ref: "#/components/schemas/Node" } }
              }
            }
          }
        }
      },
      post: {
        operationId: "addNode",
        parameters: [
          { name: "treeId", in: "path", required: true, schema: { type: "string" } }
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/Node" } }
          }
        },
        responses: { "201": { description: "created" } }
      }
    }
  }
})

describe("compiling a specification", () => {
  it("projects every operation without choking on a recursive schema", async () => {
    const compiled = await run(compileSpec("https://example.com/openapi.json", spec))
    expect(compiled.operations.map((operation) => operation.name)).toEqual([
      "addNode",
      "listNodes"
    ])
    expect(Option.getOrNull(compiled.title)).toBe("Example")
  })

  it("calls a safe method read-only and nothing else", async () => {
    const compiled = await run(compileSpec("https://example.com/openapi.json", spec))
    const readOnly = new Map(
      compiled.operations.map((operation) => [operation.name, operation.readOnly])
    )
    expect(readOnly.get("listNodes")).toBe(true)
    expect(readOnly.get("addNode")).toBe(false)
  })

  it("flattens parameters into one object and records where each came from", async () => {
    const compiled = await run(compileSpec("https://example.com/openapi.json", spec))
    const list = compiled.operations.find((operation) => operation.name === "listNodes")
    expect(list?.locations).toEqual({
      treeId: "path",
      depth: "query",
      "X-Trace": "header"
    })
    const properties = property(list?.inputSchema ?? null, "properties")
    expect(Object.keys(isJsonObject(properties) ? properties : {}).toSorted())
      .toEqual(["X-Trace", "depth", "treeId"])
  })

  it("carries only the definitions a schema reaches", async () => {
    const compiled = await run(compileSpec("https://example.com/openapi.json", spec))
    const add = compiled.operations.find((operation) => operation.name === "addNode")
    const defs = property(add?.inputSchema ?? null, "$defs")
    // `Node` is reached through the body; `Unused` is not in the document's
    // reachable set from this operation.
    expect(Object.keys(isJsonObject(defs) ? defs : {})).toEqual(["Node"])
  })

  it("keeps a body that is a reference whole under its own property", async () => {
    const compiled = await run(compileSpec("https://example.com/openapi.json", spec))
    const add = compiled.operations.find((operation) => operation.name === "addNode")
    expect(Option.getOrNull(add?.bodyProperty ?? Option.none())).toBe("body")
    expect(add?.locations["body"]).toBe("body")
  })

  it("derives the auth methods the document declares", async () => {
    const compiled = await run(compileSpec("https://example.com/openapi.json", spec))
    expect(compiled.securitySchemes.map((entry) => entry.name)).toEqual(["bearerAuth"])
  })
})

describe("resolving the server", () => {
  it("resolves a relative server against where the document was fetched", async () => {
    const compiled = await run(compileSpec("https://example.com/openapi.json", spec))
    expect(Option.getOrNull(resolveServer(compiled, {
      baseUrl: Option.none(),
      specSource: Option.some("https://example.com/openapi.json")
    }))).toBe("https://example.com/api/v2")
  })

  it("prefers an operator's override over the document", async () => {
    const compiled = await run(compileSpec("https://example.com/openapi.json", spec))
    expect(Option.getOrNull(resolveServer(compiled, {
      baseUrl: Option.some("https://staging.example.com"),
      specSource: Option.some("https://example.com/openapi.json")
    }))).toBe("https://staging.example.com")
  })
})

describe("splitting a caller's input", () => {
  it("routes each property to the location the operation declared", async () => {
    const compiled = await run(compileSpec("https://example.com/openapi.json", spec))
    const list = compiled.operations.find((operation) => operation.name === "listNodes")!
    const split = splitInput(list, { treeId: "t1", depth: 3, "X-Trace": "abc" })
    expect(split.parameters).toEqual({ treeId: "t1", depth: 3, "X-Trace": "abc" })
    expect(Option.isNone(split.requestBody)).toBe(true)
    expect(split.unknown).toEqual([])
  })

  it("reports a property the operation does not declare instead of forwarding it", async () => {
    const compiled = await run(compileSpec("https://example.com/openapi.json", spec))
    const list = compiled.operations.find((operation) => operation.name === "listNodes")!
    const split = splitInput(list, { treeId: "t1", invented: "x" })
    // Forwarding it would default to the query string, turning a caller's typo
    // into a filter nobody asked for.
    expect(split.unknown).toEqual(["invented"])
    expect(split.parameters).toEqual({ treeId: "t1" })
  })

  it("separates the body from the parameters", async () => {
    const compiled = await run(compileSpec("https://example.com/openapi.json", spec))
    const add = compiled.operations.find((operation) => operation.name === "addNode")!
    const split = splitInput(add, { treeId: "t1", body: { label: "root" } })
    expect(split.parameters).toEqual({ treeId: "t1" })
    expect(Option.getOrNull(split.requestBody)).toEqual({ label: "root" })
  })
})

describe("previewing a specification", () => {
  it("summarises without installing anything", async () => {
    const compiled = await run(compileSpec("https://example.com/openapi.json", spec))
    const preview = await run(previewOf(compiled))
    expect(preview.operationCount).toBe(2)
    expect(preview.servers).toEqual([{ url: "/api/v2", description: null }])
    expect(preview.securitySchemes[0]?.type).toBe("http")
  })
})

describe("Google Discovery", () => {
  const discovery = JSON.stringify({
    kind: "discovery#restDescription",
    name: "gmail",
    version: "v1",
    title: "Gmail API",
    rootUrl: "https://gmail.googleapis.com/",
    servicePath: "gmail/v1/",
    auth: {
      oauth2: {
        scopes: { "https://www.googleapis.com/auth/gmail.send": { description: "Send" } }
      }
    },
    parameters: {
      alt: { type: "string", location: "query", enum: ["json", "media"] }
    },
    schemas: {
      Message: {
        id: "Message",
        type: "object",
        properties: {
          id: { type: "string" },
          raw: { type: "string", format: "byte" },
          payload: { $ref: "MessagePart" }
        }
      },
      MessagePart: {
        id: "MessagePart",
        type: "object",
        properties: {
          partId: { type: "string" },
          parts: { type: "array", items: { $ref: "MessagePart" } }
        }
      }
    },
    resources: {
      users: {
        resources: {
          messages: {
            methods: {
              send: {
                id: "gmail.users.messages.send",
                path: "users/{userId}/messages/send",
                httpMethod: "POST",
                description: "Sends a message.",
                parameters: {
                  userId: { type: "string", location: "path", required: true }
                },
                request: { $ref: "Message" },
                response: { $ref: "Message" },
                scopes: ["https://www.googleapis.com/auth/gmail.send"]
              }
            }
          }
        }
      }
    }
  })

  it("recognises the URLs that serve Discovery rather than OpenAPI", () => {
    expect(isGoogleDiscoveryUrl(
      "https://www.googleapis.com/discovery/v1/apis/gmail/v1/rest"
    )).toBe(true)
    expect(isGoogleDiscoveryUrl("https://petstore3.swagger.io/api/v3/openapi.json"))
      .toBe(false)
  })

  it("converts into a document the same compilation path accepts", async () => {
    const converted = await run(convertGoogleDiscovery("gmail", discovery))
    const compiled = await run(compileSpec("gmail", converted))
    expect(Option.getOrNull(compiled.title)).toBe("Gmail API")
    expect(compiled.servers).toEqual([
      {
        url: "https://gmail.googleapis.com/gmail/v1",
        description: Option.none(),
        variables: {}
      }
    ])
    const send = compiled.operations.find(
      (operation) => operation.name === "gmail.users.messages.send"
    )
    expect(send).toBeDefined()
    expect(send?.readOnly).toBe(false)
    expect(send?.locations["userId"]).toBe("path")
  })

  it("keeps the request body callable, with its recursive schema intact", async () => {
    const converted = await run(convertGoogleDiscovery("gmail", discovery))
    const compiled = await run(compileSpec("gmail", converted))
    const send = compiled.operations.find(
      (operation) => operation.name === "gmail.users.messages.send"
    )!
    // The body is the whole point: a converter that loses it produces a tool
    // that looks callable and is not.
    expect(send.locations["body"]).toBe("body")
    const defs: Json = property(send.inputSchema, "$defs")
    expect(Object.keys(isJsonObject(defs) ? defs : {}).toSorted())
      .toEqual(["Message", "MessagePart"])
    const split = splitInput(send, { userId: "me", body: { raw: "UkFX" } })
    expect(split.parameters).toEqual({ userId: "me" })
    expect(Option.getOrNull(split.requestBody)).toEqual({ raw: "UkFX" })
  })

  it("derives OAuth with the scopes the method declares", async () => {
    const converted = await run(convertGoogleDiscovery("gmail", discovery))
    const compiled = await run(compileSpec("gmail", converted))
    const [scheme] = compiled.securitySchemes
    expect(scheme?.type).toBe("oauth2")
    expect(Option.getOrNull(scheme?.tokenUrl ?? Option.none()))
      .toBe("https://oauth2.googleapis.com/token")
    expect(scheme?.scopes).toEqual(["https://www.googleapis.com/auth/gmail.send"])
  })

  it("drops a global parameter the path does not mention", async () => {
    const converted = await run(convertGoogleDiscovery("gmail", discovery))
    const compiled = await run(compileSpec("gmail", converted))
    const send = compiled.operations.find(
      (operation) => operation.name === "gmail.users.messages.send"
    )!
    // `alt` is a global query parameter and belongs; a stray global *path*
    // parameter would not be sendable.
    expect(send.locations["alt"]).toBe("query")
  })
})
