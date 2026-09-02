import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
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

remoteDescribe("current production OpenAPI specifications", () => {
  for (const specification of specifications) {
    it(`compiles the latest ${specification.name} document`, async () => {
      const response = await fetch(specification.url)
      expect(response.ok).toBe(true)
      const document = await response.text()
      const compiled = await Effect.runPromise(compileSpec(specification.url, document))
      expect(compiled.operations.length).toBeGreaterThanOrEqual(
        specification.minimumOperations
      )
      expect(new Set(compiled.operations.map((operation) => operation.name)).size)
        .toBe(compiled.operations.length)
    })
  }
})
