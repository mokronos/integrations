import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { compileSpec } from "../../../src/openapi/compile.ts"

const enabled = process.env["RUN_REMOTE_INTEGRATION_TESTS"] === "1"
const remoteDescribe = enabled ? describe : describe.skip

const specifications = [
  {
    name: "GitHub REST API",
    url: "https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json",
    minimumOperations: 800
  },
  {
    name: "Stripe API",
    url: "https://raw.githubusercontent.com/stripe/openapi/master/latest/openapi.spec3.json",
    minimumOperations: 500
  }
] as const

const services = Layer.mergeAll(FetchHttpClient.layer)

remoteDescribe("current production OpenAPI specifications", () => {
  for (const specification of specifications) {
    it.live(`compiles the latest ${specification.name} document`, () =>
      Effect.gen(function*() {
        const response = yield* HttpClient.get(specification.url)
        expect(response.status).toBe(200)

        const compiled = yield* compileSpec(specification.url, yield* response.text)

        expect(compiled.operations.length)
          .toBeGreaterThanOrEqual(specification.minimumOperations)
        expect(new Set(compiled.operations.map((operation) => operation.name)).size)
          .toBe(compiled.operations.length)
      }).pipe(Effect.provide(services)), 120_000)
  }
})
