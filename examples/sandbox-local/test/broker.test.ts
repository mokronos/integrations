import { afterEach, describe, expect, test } from "bun:test"
import {
  decodeApiKey,
  decodeGatewayUrl,
  isAllowedBrokerRoute,
  startGatewayBroker
} from "../src/broker.ts"

const servers: Array<{ stop(closeActiveConnections?: boolean): void | Promise<void> }> = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    await server.stop(true)
  }))
})

describe("gateway broker", () => {
  test("allows the complete agent CLI surface and no operator routes", () => {
    const allowed: ReadonlyArray<readonly [string, string]> = [
      ["GET", "/v1/metadata"],
      ["GET", "/v1/registry/search"],
      ["GET", "/v1/integrations"],
      ["POST", "/v1/integrations/discover"],
      ["GET", "/v1/integrations/github/tools"],
      ["GET", "/v1/integrations/github/tools/issues.create"],
      ["POST", "/v1/validate"],
      ["GET", "/v1/connections"],
      ["POST", "/v1/connections"],
      ["POST", "/v1/connections/oauth"],
      ["GET", "/v1/connections/oauth/session-1"],
      ["DELETE", "/v1/connections/github/default"],
      ["GET", "/v1/tools"],
      ["POST", "/v1/execute"],
      ["GET", "/v1/approvals/approval-1"]
    ]
    for (const [method, path] of allowed) {
      expect(isAllowedBrokerRoute(method, path)).toBe(true)
    }

    expect(isAllowedBrokerRoute("POST", "/v1/clients")).toBe(false)
    expect(isAllowedBrokerRoute("POST", "/v1/approvals/approval-1/approve")).toBe(false)
    expect(isAllowedBrokerRoute("GET", "/v1/oauth/callback")).toBe(false)
  })

  test("replaces sandbox authentication and keeps the upstream fixed", async () => {
    const authorizations: Array<string | null> = []
    let pathname = ""
    const gateway = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        authorizations.push(request.headers.get("authorization"))
        pathname = new URL(request.url).pathname
        return Response.json({ tools: [] })
      }
    })
    servers.push(gateway)

    const broker = await startGatewayBroker({
      gatewayUrl: decodeGatewayUrl(`http://127.0.0.1:${gateway.port}`),
      apiKey: decodeApiKey("real-delegated-key"),
      onOAuthPrompt: () => undefined
    })
    servers.push({ stop: () => broker.close() })

    const response = await fetch(new URL("/v1/tools?schemas=true", broker.url), {
      headers: {
        authorization: "Bearer sandbox-placeholder",
        "x-api-key": "attacker-key",
        host: "attacker.example"
      }
    })

    expect(response.status).toBe(200)
    expect(authorizations).toEqual(["Bearer real-delegated-key"])
    expect(pathname).toBe("/v1/tools")
  })

  test("rejects administrative routes before reaching the gateway", async () => {
    let calls = 0
    const gateway = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        calls++
        return Response.json({})
      }
    })
    servers.push(gateway)
    const broker = await startGatewayBroker({
      gatewayUrl: decodeGatewayUrl(`http://127.0.0.1:${gateway.port}`),
      apiKey: decodeApiKey("real-delegated-key"),
      onOAuthPrompt: () => undefined
    })
    servers.push({ stop: () => broker.close() })

    const response = await fetch(new URL("/v1/clients", broker.url))

    expect(response.status).toBe(403)
    expect(calls).toBe(0)
  })

  test("emits one validated OAuth prompt from the gateway response", async () => {
    const gateway = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return Response.json({
          id: "oauth-1",
          integration: "github",
          connection: "default",
          state: {
            status: "pending",
            authorizationUrl: "https://github.com/login/oauth/authorize?state=opaque"
          }
        }, { status: 201 })
      }
    })
    servers.push(gateway)
    const prompts: Array<string> = []
    const broker = await startGatewayBroker({
      gatewayUrl: decodeGatewayUrl(`http://127.0.0.1:${gateway.port}`),
      apiKey: decodeApiKey("real-delegated-key"),
      onOAuthPrompt: (prompt) => prompts.push(prompt.authorizationUrl.href)
    })
    servers.push({ stop: () => broker.close() })

    const response = await fetch(new URL("/v1/connections/oauth", broker.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ integration: "github", connection: "default" })
    })
    await Bun.sleep(0)

    expect(response.status).toBe(201)
    expect(prompts).toEqual([
      "https://github.com/login/oauth/authorize?state=opaque"
    ])
  })
})
