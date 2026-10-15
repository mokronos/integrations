import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Option } from "effect"
import { Egress } from "../src/egress/egress.ts"
import { defaultUrlPolicy, httpsOnlyUrlPolicy } from "../src/egress/url-policy.ts"
import type { UrlPolicy } from "../src/egress/url-policy.ts"
import { OpenApiInvoker } from "../src/openapi/invoke.ts"
import { BlobStore } from "../src/storage/blobs.ts"

const services = (policy: UrlPolicy) =>
  OpenApiInvoker.layer.pipe(Layer.provide(Layer.mergeAll(Egress.layer(policy), BlobStore.temporaryLayer)))

const listCharges = (server: string) =>
  Effect.flatMap(OpenApiInvoker, (invoker) =>
    invoker
      .call({
        integration: "Payments",
        call: {
          kind: "http",
          method: "get",
          path: "/v1/customers/{customer}/charges",
          parameters: [],
          locations: { customer: "path" }
        },
        tool: "payments.list_charges",
        server,
        input: { customer: "cus_private" },
        credential: Option.some({
          value: "sk_live_secret",
          placements: [{ carrier: "query", name: "api_key", prefix: "" }]
        })
      })
      .pipe(Effect.flip)
  )

const closedPort = Effect.gen(function* () {
  const running = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const port = running.port
  yield* Effect.promise(() => running.stop(true))
  return port
})

describe("an unreachable OpenAPI upstream", () => {
  it.live("is a network error naming the integration and host, not the request", () =>
    Effect.gen(function* () {
      const port = yield* closedPort

      const failed = yield* listCharges(`http://127.0.0.1:${port}`)

      expect(failed._tag).toBe("InvocationError")
      if (failed._tag !== "InvocationError") return
      expect(failed.code).toBe("network")
      expect(failed.detail).toBe(
        `Payments could not reach 127.0.0.1:${port}. Check its base URL and that the service is online.`
      )
    }).pipe(Effect.provide(services(defaultUrlPolicy)))
  )

  it.live("names a destination the egress policy refuses", () =>
    Effect.gen(function* () {
      const failed = yield* listCharges("https://10.0.0.7")

      expect(failed._tag).toBe("InvocationError")
      if (failed._tag !== "InvocationError") return
      expect(failed.code).toBe("network")
      expect(failed.detail).toBe("Payments: 10.0.0.7 is not a destination this gateway may reach")
    }).pipe(Effect.provide(services(httpsOnlyUrlPolicy)))
  )
})
