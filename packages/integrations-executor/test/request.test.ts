import { describe, expect, it } from "bun:test"
import { Effect, Option } from "effect"
import { compileSpec, splitInput } from "../src/openapi.ts"
import { buildRequest } from "../src/request.ts"
import type { CompiledSpec } from "../src/openapi.ts"
import type { Json } from "../src/json.ts"

/** A document covering every parameter style OpenAPI allows a caller to use,
 *  plus a templated server. */
const document = JSON.stringify({
  openapi: "3.0.3",
  info: { title: "Styles", version: "1" },
  servers: [{
    url: "https://api.example.com/{ver}",
    variables: { ver: { default: "v2" } }
  }],
  paths: {
    "/u/{id}/m": {
      get: {
        operationId: "list",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          {
            name: "labels",
            in: "query",
            style: "form",
            explode: false,
            schema: { type: "array", items: { type: "string" } }
          },
          { name: "tags", in: "query", schema: { type: "array", items: { type: "string" } } },
          {
            name: "filter",
            in: "query",
            style: "deepObject",
            explode: true,
            schema: { type: "object", properties: { unread: { type: "boolean" } } }
          },
          {
            name: "ids",
            in: "query",
            style: "spaceDelimited",
            explode: false,
            schema: { type: "array", items: { type: "integer" } }
          },
          {
            name: "pipes",
            in: "query",
            style: "pipeDelimited",
            explode: false,
            schema: { type: "array", items: { type: "string" } }
          },
          { name: "q", in: "query", schema: { type: "string" } },
          { name: "X-Trace", in: "header", schema: { type: "string" } }
        ],
        responses: { "200": { description: "ok" } }
      },
      post: {
        operationId: "send",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } }
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { type: "object", properties: { text: { type: "string" } } }
            }
          }
        },
        responses: { "201": { description: "created" } }
      }
    },
    "/forms": {
      post: {
        operationId: "submitForm",
        requestBody: {
          required: true,
          content: {
            "application/x-www-form-urlencoded": {
              schema: {
                type: "object",
                properties: { a: { type: "string" }, b: { type: "string" } }
              }
            }
          }
        },
        responses: { "200": { description: "ok" } }
      }
    }
  }
})

const spec: CompiledSpec = await Effect.runPromise(
  compileSpec("https://api.example.com/openapi.json", document)
)

const operation = (name: string) => {
  const found = spec.operations.find((candidate) => candidate.name === name)
  if (found === undefined) throw new Error(`no operation ${name}`)
  return found
}

const build = (
  name: string,
  input: Record<string, Json>,
  server = "https://api.example.com/{ver}"
) => {
  const op = operation(name)
  const split = splitInput(op, input)
  return buildRequest({
    spec,
    operation: op,
    server,
    parameters: split.parameters,
    requestBody: split.requestBody
  })
}

describe("path and server", () => {
  it("fills a server's own template variables from their declared defaults", () => {
    expect(build("list", { id: "u1" }).url)
      .toBe("https://api.example.com/v2/u/u1/m")
  })

  it("percent-encodes a path value so it cannot invent a segment", () => {
    // A `/` inside a value must not become a path separator.
    expect(build("list", { id: "a/b c" }).url)
      .toBe("https://api.example.com/v2/u/a%2Fb%20c/m")
  })

  it("leaves an unsupplied placeholder in place rather than collapsing the path", () => {
    // Two segments joined into one would reach a different endpoint entirely.
    // In practice the invoker rejects such a call first, because `id` is
    // required — the request builder itself stays pure.
    expect(build("list", {}).url).toBe("https://api.example.com/v2/u/{id}/m")
  })

  it("uses an operator's base URL in place of the document's server", () => {
    expect(build("list", { id: "u1" }, "https://staging.example.com/api").url)
      .toBe("https://staging.example.com/api/u/u1/m")
  })
})

describe("query serialisation", () => {
  const query = (input: Record<string, Json>): URLSearchParams =>
    new URL(build("list", { id: "u1", ...input }).url).searchParams

  it("joins an unexploded form array with commas", () => {
    expect(query({ labels: ["inbox", "starred"] }).get("labels")).toBe("inbox,starred")
  })

  it("repeats the name for an array that is exploded by default", () => {
    // `form` is the default style in a query and `form` explodes by default,
    // so `tags` repeats without the document saying so.
    expect(query({ tags: ["a", "b"] }).getAll("tags")).toEqual(["a", "b"])
  })

  it("brackets a deepObject", () => {
    expect(query({ filter: { unread: true } }).get("filter[unread]")).toBe("true")
  })

  it("honours spaceDelimited and pipeDelimited", () => {
    expect(query({ ids: [1, 2, 3] }).get("ids")).toBe("1 2 3")
    expect(query({ pipes: ["x", "y"] }).get("pipes")).toBe("x|y")
  })

  it("encodes a value that would otherwise change the URL's meaning", () => {
    const url = build("list", { id: "u1", q: "a&b=c d" }).url
    expect(url).toContain("q=a%26b%3Dc+d")
    expect(new URL(url).searchParams.get("q")).toBe("a&b=c d")
  })

  it("omits a parameter the caller did not supply", () => {
    expect(build("list", { id: "u1" }).url).not.toContain("?")
  })
})

describe("headers", () => {
  it("sends a header parameter under its own name", () => {
    expect(build("list", { id: "u1", "X-Trace": "abc" }).headers["X-Trace"]).toBe("abc")
  })
})

describe("bodies", () => {
  it("serialises a JSON body and declares its media type", () => {
    const built = build("send", { id: "u1", body: { text: "hello" } })
    expect(built.method).toBe("POST")
    expect(Option.getOrNull(built.body)).toBe("{\"text\":\"hello\"}")
    expect(built.headers["content-type"]).toBe("application/json")
  })

  it("form-encodes a body the operation declares as a form", () => {
    const built = build("submitForm", { body: { a: "1", b: "x y" } })
    expect(Option.getOrNull(built.body)).toBe("a=1&b=x+y")
    expect(built.headers["content-type"]).toBe("application/x-www-form-urlencoded")
  })

  it("sends no body, and no content type, when there is none", () => {
    const built = build("list", { id: "u1" })
    expect(Option.isNone(built.body)).toBe(true)
    expect(built.headers["content-type"]).toBeUndefined()
  })
})
