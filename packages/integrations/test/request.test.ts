import { expect, it } from "@effect/vitest"
import { Context, Effect, Layer, Option } from "effect"
import { compileSpec, resolveServer } from "../src/openapi/compile.ts"
import { splitArguments } from "../src/openapi/arguments.ts"
import { buildRequest } from "../src/openapi/request.ts"
import { captureOpenApiTools } from "../src/catalog/capture.ts"
import type { HttpCall } from "../src/tool.ts"
import { ConnectionName, IntegrationSlug } from "@integrations/contracts"
import type { Json } from "@integrations/contracts"

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

/** The requests this document's operations build, compiled once for the suite. */
class Requests extends Context.Service<Requests, {
  readonly build: (
    name: string,
    input: Record<string, Json>,
    server?: string
  ) => ReturnType<typeof buildRequest>
}>()("test/Requests") {
  static readonly layer = Layer.effect(Requests, Effect.gen(function*() {
    const specSource = "https://api.example.com/openapi.json"
    const spec = yield* compileSpec(specSource, document)
    const captured = yield* captureOpenApiTools(
      {
        owner: "org",
        integration: IntegrationSlug.make("styles"),
        connection: ConnectionName.make("default")
      },
      spec,
      0
    )
    const httpCall = (name: string): HttpCall => {
      const found = captured.find((candidate) => candidate.name === name)
      if (found === undefined) throw new Error(`no tool ${name}`)
      if (found.call.kind !== "http") throw new Error(`${name} is not an HTTP call`)
      return found.call
    }
    const defaultServer = Option.getOrThrow(resolveServer(spec, {
      baseUrl: Option.none(),
      specSource: Option.some(specSource)
    }))
    return {
      build: (name: string, input: Record<string, Json>, server = defaultServer) => {
        const call = httpCall(name)
        const split = splitArguments(call, input)
        return buildRequest({
          call,
          server,
          parameters: split.parameters,
          requestBody: split.requestBody
        })
      }
    }
  }))
}

it.layer(Requests.layer)("path and server", (it) => {
  it.effect("fills a server's own template variables from their declared defaults", () =>
    Effect.gen(function*() {
      const { build } = yield* Requests
      expect(build("list", { id: "u1" }).url)
        .toBe("https://api.example.com/v2/u/u1/m")
    }))

  it.effect("percent-encodes a path value so it cannot invent a segment", () =>
    Effect.gen(function*() {
      const { build } = yield* Requests
      expect(build("list", { id: "a/b c" }).url)
        .toBe("https://api.example.com/v2/u/a%2Fb%20c/m")
    }))

  it.effect("leaves an unsupplied placeholder in place rather than collapsing the path", () =>
    Effect.gen(function*() {
      const { build } = yield* Requests
      expect(build("list", {}).url).toBe("https://api.example.com/v2/u/{id}/m")
    }))

  it.effect("uses an operator's base URL in place of the document's server", () =>
    Effect.gen(function*() {
      const { build } = yield* Requests
      expect(build("list", { id: "u1" }, "https://staging.example.com/api").url)
        .toBe("https://staging.example.com/api/u/u1/m")
    }))
})

const queryOf = (
  build: Requests["Service"]["build"],
  input: Record<string, Json>
): URLSearchParams => new URL(build("list", { id: "u1", ...input }).url).searchParams

it.layer(Requests.layer)("query serialisation", (it) => {
  it.effect("joins an unexploded form array with commas", () =>
    Effect.gen(function*() {
      const { build } = yield* Requests
      expect(queryOf(build, { labels: ["inbox", "starred"] }).get("labels")).toBe("inbox,starred")
    }))

  it.effect("repeats the name for an array that is exploded by default", () =>
    Effect.gen(function*() {
      const { build } = yield* Requests
      expect(queryOf(build, { tags: ["a", "b"] }).getAll("tags")).toEqual(["a", "b"])
    }))

  it.effect("brackets a deepObject", () =>
    Effect.gen(function*() {
      const { build } = yield* Requests
      expect(queryOf(build, { filter: { unread: true } }).get("filter[unread]")).toBe("true")
    }))

  it.effect("honours spaceDelimited and pipeDelimited", () =>
    Effect.gen(function*() {
      const { build } = yield* Requests
      expect(queryOf(build, { ids: [1, 2, 3] }).get("ids")).toBe("1 2 3")
      expect(queryOf(build, { pipes: ["x", "y"] }).get("pipes")).toBe("x|y")
    }))

  it.effect("encodes a value that would otherwise change the URL's meaning", () =>
    Effect.gen(function*() {
      const { build } = yield* Requests
      const url = build("list", { id: "u1", q: "a&b=c d" }).url
      expect(url).toContain("q=a%26b%3Dc+d")
      expect(new URL(url).searchParams.get("q")).toBe("a&b=c d")
    }))

  it.effect("omits a parameter the caller did not supply", () =>
    Effect.gen(function*() {
      const { build } = yield* Requests
      expect(build("list", { id: "u1" }).url).not.toContain("?")
    }))
})

it.layer(Requests.layer)("headers", (it) => {
  it.effect("sends a header parameter under its own name", () =>
    Effect.gen(function*() {
      const { build } = yield* Requests
      expect(build("list", { id: "u1", "X-Trace": "abc" }).headers["X-Trace"]).toBe("abc")
    }))
})

it.layer(Requests.layer)("bodies", (it) => {
  it.effect("serialises a JSON body and declares its media type", () =>
    Effect.gen(function*() {
      const { build } = yield* Requests
      const built = build("send", { id: "u1", body: { text: "hello" } })
      expect(built.method).toBe("POST")
      expect(Option.getOrNull(built.body)).toBe("{\"text\":\"hello\"}")
      expect(built.headers["content-type"]).toBe("application/json")
    }))

  it.effect("form-encodes a body the operation declares as a form", () =>
    Effect.gen(function*() {
      const { build } = yield* Requests
      const built = build("submitForm", { body: { a: "1", b: "x y" } })
      expect(Option.getOrNull(built.body)).toBe("a=1&b=x+y")
      expect(built.headers["content-type"]).toBe("application/x-www-form-urlencoded")
    }))

  it.effect("sends no body, and no content type, when there is none", () =>
    Effect.gen(function*() {
      const { build } = yield* Requests
      const built = build("list", { id: "u1" })
      expect(Option.isNone(built.body)).toBe(true)
      expect(built.headers["content-type"]).toBeUndefined()
    }))
})
