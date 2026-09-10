import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { compileSpec } from "../../../src/openapi/compile.ts"

const fixtures = [
  {
    name: "GitHub REST API",
    file: new URL("../fixtures/openapi/github.json", import.meta.url),
    source: "https://github.com/github/rest-api-description/commit/e521e5ff242529a57d4115cf24af0a7879689e62",
    minimumOperations: 800
  },
  {
    name: "Stripe API",
    file: new URL("../fixtures/openapi/stripe.json", import.meta.url),
    source: "https://github.com/stripe/openapi/commit/8901983118acff7e5564af3c100a3e8252c0c4b2",
    minimumOperations: 500
  }
] as const

describe("pinned production OpenAPI specifications", () => {
  for (const fixture of fixtures) {
    it.effect(`compiles ${fixture.name}`, () =>
      Effect.gen(function*() {
        const bytes = yield* Effect.promise(() => Bun.file(fixture.file).arrayBuffer())

        const compiled = yield* compileSpec(
          fixture.source,
          new TextDecoder().decode(bytes)
        )
        expect(compiled.operations.length).toBeGreaterThanOrEqual(fixture.minimumOperations)
        expect(compiled.operations.every((operation) => operation.name.length > 0)).toBe(true)
        expect(new Set(compiled.operations.map((operation) => operation.name)).size)
          .toBe(compiled.operations.length)
      }), 60_000)
  }
})
