import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { whenPresent } from "@integrations/contracts"
import {
  createGatewayHandler,
  defaultTenantId,
  generateApiKey,
  newClientId
} from "./gateway.ts"
import type { GatewayStore } from "./gateway.ts"
import { stubIntegrationsContext } from "./stubs.ts"
import { gatewayStore, testServices } from "./fixtures.ts"

const JsonBody = Schema.Record(Schema.String, Schema.Json)

const bodyOf = (response: Response) =>
  Effect.map(
    Effect.promise(() => response.json()),
    Schema.decodeUnknownSync(JsonBody)
  )

describe("gateway traffic shaping", () => {
  const keyFor = Effect.fnUntraced(function*(store: GatewayStore, name: string) {
    const accessProfile = yield* store.findDefaultAccessProfile(defaultTenantId)
    const approvalPolicy = yield* store.findDefaultApprovalPolicy(defaultTenantId)
    if (accessProfile === undefined || approvalPolicy === undefined) {
      throw new Error("missing defaults")
    }
    const client = yield* store.createClient({
      id: yield* newClientId,
      tenantId: defaultTenantId,
      accessProfileId: accessProfile.id,
      approvalPolicyId: approvalPolicy.id,
      name,
      capabilities: ["provision_connections", "administer_gateway"]
    })
    const key = yield* generateApiKey
    yield* store.addApiKey({ id: key.id, clientId: client.id, hash: key.hash })
    return key
  })

  const setup = Effect.fnUntraced(function*(options: {
    readonly addressLimit?: number
    readonly principalLimit?: number
    readonly maxBodyBytes?: number
  } = {}) {
    const store = yield* gatewayStore("gateway-limits-")
    const key = yield* keyFor(store, "local")

    const { handle } = createGatewayHandler({
      httpClient: FetchHttpClient.layer,
      integrationServices: stubIntegrationsContext(),
      store,
      retentionDays: 30,
      oauth: {
        start: () => Effect.die(new Error("not used")),
        get: () => Effect.sync((): undefined => undefined),
        completeByState: () => Effect.sync((): undefined => undefined),
        stop: () => Effect.void
      },
      rateLimits: {
        addressPerMinute: options.addressLimit ?? 3,
        principalPerMinute: options.principalLimit ?? 1000
      },
      ...whenPresent("maxBodyBytes", options.maxBodyBytes)
    })

    const send = (request: Request) => Effect.promise(() => handle(request))
    const get = (pathname: string, secret?: string) =>
      send(new Request(`http://gateway.test${pathname}`, {
        headers: secret === undefined ? {} : { authorization: `Bearer ${secret}` }
      }))

    return { store, key, send, get }
  })

  it.effect("an address that exhausts its pre-auth bucket gets 429 with Retry-After", () =>
    Effect.gen(function*() {
      const { get } = yield* setup({ addressLimit: 2 })

      expect((yield* get("/v1/tools")).status).toBe(401)
      expect((yield* get("/v1/tools")).status).toBe(401)

      const refused = yield* get("/v1/tools")
      expect(refused.status).toBe(429)
      expect(refused.headers.get("retry-after")).toBe("60")
      expect((yield* bodyOf(refused))["code"]).toBe("rate-limited")
    }).pipe(Effect.provide(testServices)))

  it.effect("health stays reachable under load — it is what the monitor polls", () =>
    Effect.gen(function*() {
      const { get } = yield* setup({ addressLimit: 1 })

      expect((yield* get("/v1/health")).status).toBe(200)
      yield* get("/v1/tools")
      expect((yield* get("/v1/tools")).status).toBe(429)

      expect((yield* get("/v1/health")).status).toBe(200)
    }).pipe(Effect.provide(testServices)))

  it.effect("one exhausted principal does not starve another", () =>
    Effect.gen(function*() {
      const { get, key, store } = yield* setup({ principalLimit: 2, addressLimit: 10_000 })
      const neighbour = yield* keyFor(store, "neighbour")

      expect((yield* get("/v1/tools", key.secret)).status).toBe(200)
      expect((yield* get("/v1/tools", key.secret)).status).toBe(200)
      expect((yield* get("/v1/tools", key.secret)).status).toBe(429)

      expect((yield* get("/v1/tools", neighbour.secret)).status).toBe(200)
    }).pipe(Effect.provide(testServices)))

  it.effect("an oversized body is refused with 413 before any handler runs", () =>
    Effect.gen(function*() {
      const { key, send } = yield* setup({ maxBodyBytes: 16 })
      const body = JSON.stringify({ name: "x".repeat(64) })

      const response = yield* send(new Request("http://gateway.test/v1/clients", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${key.secret}`,
          "content-length": String(Buffer.byteLength(body))
        },
        body
      }))

      expect(response.status).toBe(413)
      expect(String((yield* bodyOf(response))["error"])).toContain("exceeds")
    }).pipe(Effect.provide(testServices)))
})
