import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { compileSpec } from "../../../src/openapi/compile.ts"

const fixtures = [
  {
    name: "GitHub REST API",
    file: new URL("../fixtures/openapi/github.json", import.meta.url),
    source: "https://github.com/github/rest-api-description/commit/e521e5ff242529a57d4115cf24af0a7879689e62",
    sha256: "da931321b6b3f5ad59a08cb389ec59f36f15972b85925bbc8448878a8384746a",
    minimumOperations: 800
  },
  {
    name: "Stripe API",
    file: new URL("../fixtures/openapi/stripe.json", import.meta.url),
    source: "https://github.com/stripe/openapi/commit/8901983118acff7e5564af3c100a3e8252c0c4b2",
    sha256: "6f3623aece40493eec2f5e3e631219f8c6bffa4f477e3807a4bf785ad377f237",
    minimumOperations: 500
  }
] as const

describe("pinned production OpenAPI specifications", () => {
  for (const fixture of fixtures) {
    it(`compiles ${fixture.name}`, async () => {
      const file = Bun.file(fixture.file)
      const bytes = await file.arrayBuffer()
      const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
      expect(hash).toBe(fixture.sha256)

      const compiled = await Effect.runPromise(compileSpec(
        fixture.source,
        new TextDecoder().decode(bytes)
      ))
      expect(compiled.operations.length).toBeGreaterThanOrEqual(fixture.minimumOperations)
      expect(compiled.operations.every((operation) => operation.name.length > 0)).toBe(true)
      expect(new Set(compiled.operations.map((operation) => operation.name)).size)
        .toBe(compiled.operations.length)
    })
  }
})
