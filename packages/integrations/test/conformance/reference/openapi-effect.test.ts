import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Option } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { ConnectionName, IntegrationSlug } from "@integrations/contracts"
import { captureOpenApiTools } from "../../../src/catalog/capture.ts"
import { compileSpec } from "../../../src/openapi/compile.ts"
import { OpenApiInvoker } from "../../../src/openapi/invoke.ts"
import {
  referenceOpenApiDocument,
  referenceOpenApiServer
} from "../support/reference-openapi.ts"

const services = OpenApiInvoker.layer.pipe(Layer.provide(FetchHttpClient.layer))

describe("Effect OpenAPI reference server", () => {
  it.live("compiles and invokes the Effect-defined contract", () =>
    Effect.gen(function*() {
      const baseUrl = yield* referenceOpenApiServer
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
      const result = yield* invoker.call({
        call: echo.call,
        tool: echo.name,
        server: baseUrl,
        input: {
          id: "a/b",
          search: "working",
          "x-trace": "trace-42",
          body: { message: "hello" }
        },
        credential: Option.none()
      })

      expect(result).toEqual({
        id: "a/b",
        search: "working",
        trace: "trace-42",
        message: "hello"
      })
    }).pipe(Effect.provide(services)))
})
