import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { CatalogStore } from "../src/catalog/store.ts"
import { classify } from "../src/classify.ts"
import { Egress } from "../src/egress/egress.ts"
import { defaultUrlPolicy } from "../src/egress/url-policy.ts"
import { McpClient } from "../src/mcp/client.ts"
import { SpecCache } from "../src/openapi/cache.ts"
import { temporarySqlLayer } from "../src/runtime.ts"
import { Database } from "../src/storage/database.ts"

const services = Layer.mergeAll(McpClient.layer, SpecCache.layer).pipe(
  Layer.provideMerge(CatalogStore.layer),
  Layer.provideMerge(Layer.mergeAll(Database.layer, Egress.layer(defaultUrlPolicy))),
  Layer.provide(temporarySqlLayer)
)

describe("detecting an integration", () => {
  it.live("asks for the scheme a URL leaves out instead of probing it", () =>
    Effect.gen(function* () {
      const failures = yield* Effect.forEach(["tasks.example.com/mcp", "localhost:8080/mcp"], (url) =>
        Effect.flip(classify(url))
      )
      expect(failures.map((failure) => failure.detail)).toEqual([
        "it has no http:// or https:// scheme; did you mean https://tasks.example.com/mcp?",
        "it has no http:// or https:// scheme; did you mean https://localhost:8080/mcp?"
      ])
    }).pipe(Effect.provide(services))
  )
})
