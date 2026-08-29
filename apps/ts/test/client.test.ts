import { describe, expect, test } from "bun:test"
import {
  createGatewayClient,
  GatewayProtocolError,
  gatewayProtocolVersion
} from "../src/index.ts"

const fetchOf = (protocolVersion: number) => {
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

describe("gateway protocol compatibility", () => {
  test("rejects an incompatible gateway before sending an authenticated request", async () => {
    const transport = fetchOf(gatewayProtocolVersion + 1)
    const client = createGatewayClient({
      url: "https://gateway.example",
      apiKey: "wfi_test",
      fetch: transport.fetch
    })

    await expect(client.connections()).rejects.toBeInstanceOf(GatewayProtocolError)
    await expect(client.connections()).rejects.toThrow(
      `client requires ${gatewayProtocolVersion}`
    )
    expect(transport.metadataRequests()).toBe(1)
    expect(transport.authenticatedRequests()).toHaveLength(0)
  })

  test("checks compatible metadata once and authenticates delegated calls", async () => {
    const transport = fetchOf(gatewayProtocolVersion)
    const client = createGatewayClient({
      url: "https://gateway.example/",
      apiKey: "wfi_test",
      fetch: transport.fetch
    })

    expect((await client.metadata()).gatewayVersion).toBe("test")
    expect((await client.connections()).connections).toEqual([])
    expect(await client.health()).toBe(true)
    expect(transport.metadataRequests()).toBe(1)
    expect(transport.authenticatedRequests()).toHaveLength(1)
    expect(transport.authenticatedRequests()[0]?.get("authorization")).toBe("Bearer wfi_test")
  })
})
