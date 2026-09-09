import { describe, expect, test } from "bun:test"
import { Effect, Result } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import {
  GatewayProtocolError,
  gatewayProtocolVersion,
  makeGatewayClient
} from "../src/index.ts"

const transportOf = (protocolVersion: number) => {
  let metadataRequests = 0
  const authenticatedRequests: Array<Headers> = []
  const implementation = async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1]
  ): Promise<Response> => {
    const url = String(input)
    if (url.endsWith("/v1/metadata")) {
      metadataRequests += 1
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

const withClient = <A, E>(
  transport: ReturnType<typeof transportOf>,
  url: string,
  use: (client: Effect.Success<ReturnType<typeof makeGatewayClient>>) => Effect.Effect<A, E>
): Promise<A> =>
  Effect.runPromise(
    makeGatewayClient({ url, apiKey: "wfi_test" }).pipe(
      Effect.flatMap(use),
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, transport.fetch)
    )
  )

describe("gateway protocol compatibility", () => {
  test("rejects an incompatible gateway before sending an authenticated request", async () => {
    const transport = transportOf(gatewayProtocolVersion + 1)
    const attempts = await withClient(
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
  })

  test("checks compatible metadata once and authenticates delegated calls", async () => {
    const transport = transportOf(gatewayProtocolVersion)
    const observed = await withClient(
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
    expect(transport.authenticatedRequests()[0]?.get("authorization")).toBe("Bearer wfi_test")
  })
})
