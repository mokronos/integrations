import { describe, expect, it } from "@effect/vitest"
import { Effect, Result } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import {
  GatewayProtocolError,
  GatewayUnavailableError,
  gatewayProtocolVersion,
  makeGatewayClient
} from "../src/index.ts"

const transportOf = (protocolVersion: number | "unavailable") => {
  let metadataRequests = 0
  const authenticatedRequests: Array<Headers> = []
  const implementation = async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1]
  ): Promise<Response> => {
    const url = String(input)
    if (url.endsWith("/v1/metadata")) {
      metadataRequests += 1
      if (protocolVersion === "unavailable") throw new Error("connection refused")
      return Response.json({ ok: true, protocolVersion, gatewayVersion: "test" })
    }
    if (url.endsWith("/v1/connections")) {
      authenticatedRequests.push(new Headers(init?.headers))
      return Response.json({ connections: [] })
    }
    return Response.json({ error: "not found" }, { status: 404 })
  }
  return {
    fetch: Object.assign(implementation, { preconnect: globalThis.fetch.preconnect }),
    metadataRequests: () => metadataRequests,
    authenticatedRequests: () => authenticatedRequests
  }
}

/** A client talking to the given transport rather than the network. */
const withClient = <A, E>(
  transport: ReturnType<typeof transportOf>,
  url: string,
  use: (client: Effect.Success<ReturnType<typeof makeGatewayClient>>) => Effect.Effect<A, E>
): Effect.Effect<A, E> =>
  makeGatewayClient({ url, apiKey: "igk_test" }).pipe(
    Effect.flatMap(use),
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.Fetch, transport.fetch)
  )

describe("gateway metadata", () => {
  it.effect("reports an unreachable gateway separately from protocol incompatibility", () =>
    Effect.gen(function*() {
      const transport = transportOf("unavailable")

      const result = yield* withClient(
        transport,
        "https://gateway.example",
        (client) => Effect.result(client.metadata)
      )

      expect(Result.isFailure(result)).toBe(true)
      const failure = Result.isFailure(result) ? result.failure : undefined
      expect(failure).toBeInstanceOf(GatewayUnavailableError)
      expect(String(failure)).toContain("Gateway at https://gateway.example is unavailable")
      expect(String(failure)).toContain("Retry the same command")
      expect(transport.metadataRequests()).toBe(1)
      expect(transport.authenticatedRequests()).toHaveLength(0)
    }))

  it.effect("rejects an incompatible gateway before sending an authenticated request", () =>
    Effect.gen(function*() {
      const transport = transportOf(gatewayProtocolVersion + 1)

      const attempts = yield* withClient(
        transport,
        "https://gateway.example",
        (client) =>
          Effect.all([
            Effect.result(client.provisioning.listConnections()),
            Effect.result(client.provisioning.listConnections())
          ])
      )

      for (const attempt of attempts) {
        expect(Result.isFailure(attempt)).toBe(true)
        const failure = Result.isFailure(attempt) ? attempt.failure : undefined
        expect(failure).toBeInstanceOf(GatewayProtocolError)
        expect(String(failure)).toContain(`client requires ${gatewayProtocolVersion}`)
      }
      expect(transport.metadataRequests()).toBe(1)
      expect(transport.authenticatedRequests()).toHaveLength(0)
    }))

  it.effect("checks compatible metadata once and authenticates delegated calls", () =>
    Effect.gen(function*() {
      const transport = transportOf(gatewayProtocolVersion)

      const observed = yield* withClient(
        transport,
        "https://gateway.example/",
        (client) =>
          Effect.all({
            metadata: client.metadata,
            connections: client.provisioning.listConnections(),
            health: client.health
          })
      )

      expect(observed.metadata.gatewayVersion).toBe("test")
      expect(observed.connections.connections).toEqual([])
      expect(observed.health).toBe(true)
      expect(transport.metadataRequests()).toBe(1)
      expect(transport.authenticatedRequests()).toHaveLength(1)
      expect(transport.authenticatedRequests()[0]?.get("authorization")).toBe("Bearer igk_test")
    }))
})
