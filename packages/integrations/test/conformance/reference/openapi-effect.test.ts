import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { ConnectionName, IntegrationSlug } from "@mokronos/contracts"
import { captureOpenApiTools } from "../../../src/catalog/capture.ts"
import { HttpTransport } from "../../../src/http-transport.ts"
import { compileSpec } from "../../../src/openapi/compile.ts"
import { OpenApiInvoker } from "../../../src/openapi/invoke.ts"
import {
  referenceOpenApiDocument,
  startReferenceOpenApiServer,
  type ReferenceOpenApiServer
} from "../support/reference-openapi.ts"

describe("Effect OpenAPI reference server", () => {
  let reference: ReferenceOpenApiServer

  beforeAll(() => {
    reference = startReferenceOpenApiServer()
  })

  afterAll(() => {
    reference.stop()
  })

  it("compiles and invokes the Effect-defined contract", async () => {
    const result = await Effect.runPromise(Effect.gen(function*() {
      const compiled = yield* compileSpec("effect-reference", referenceOpenApiDocument)
      const tools = yield* captureOpenApiTools({
        owner: "org",
        integration: IntegrationSlug.make("effect-reference"),
        connection: ConnectionName.make("default")
      }, compiled, 0)
      const echo = tools.find((tool) => tool.name === "reference.echo")
      if (echo === undefined || echo.call.kind !== "http") {
        return yield* Effect.die(new Error("Effect OpenAPI document has no echo operation"))
      }
      const invoker = yield* OpenApiInvoker
      return yield* invoker.call({
        call: echo.call,
        tool: echo.name,
        server: reference.baseUrl,
        input: {
          id: "a/b",
          search: "working",
          "x-trace": "trace-42",
          body: { message: "hello" }
        },
        credential: Option.none()
      })
    }).pipe(Effect.provide(
      OpenApiInvoker.layer.pipe(Layer.provide(HttpTransport.layer))
    )))

    expect(result).toEqual({
      id: "a/b",
      search: "working",
      trace: "trace-42",
      message: "hello"
    })
  })
})
