import { describe, expect, test } from "bun:test"
import {
  createGatewayClient,
  GatewayProtocolError,
  gatewayProtocolVersion
} from "../src/index.ts"

const fetchOf = (protocolVersion: number) => {
  let healthRequests = 0
  const implementation = async (
    input: Parameters<typeof globalThis.fetch>[0]
  ): Promise<Response> => {
    const url = String(input)
    if (url.endsWith("/v1/metadata")) {
      healthRequests += 1
      return Response.json({ ok: true, protocolVersion, gatewayVersion: "test" })
    }
    if (url.endsWith("/v1/connections")) {
      return Response.json({ connections: [] })
    }
    return Response.json({ error: "not found" }, { status: 404 })
  }
  return {
    fetch: Object.assign(implementation, { preconnect: globalThis.fetch.preconnect }),
    healthRequests: () => healthRequests
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
    expect(transport.healthRequests()).toBe(1)
  })

  test("checks compatible metadata once per client", async () => {
    const transport = fetchOf(gatewayProtocolVersion)
    const client = createGatewayClient({
      url: "https://gateway.example/",
      apiKey: "wfi_test",
      fetch: transport.fetch
    })

    expect((await client.metadata()).gatewayVersion).toBe("test")
    expect((await client.connections()).connections).toEqual([])
    expect(await client.health()).toBe(true)
    expect(transport.healthRequests()).toBe(1)
  })
})
