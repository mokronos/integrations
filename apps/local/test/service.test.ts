import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Schema } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { GatewayMetadata } from "@integragents/contracts"
import { gatewayVersion } from "@integragents/gateway-api"
import {
  defaultTenantId,
  gatewayConfigPath,
  generateApiKey,
  localAgentClientName,
  localClientName,
  newClientId,
  operatorGatewayConfigPath,
  readGatewayConfig,
  readOperatorGatewayConfig,
  resolveClientConnection,
  resolveOperatorConnection,
  serveGateway
} from "../index.ts"
import { temporaryDirectory, testServices } from "./fixtures.ts"

const services = Layer.merge(testServices, FetchHttpClient.layer)

/** A gateway on a loopback port, stopped when the test's scope ends. */
const gateway = Effect.flatMap(temporaryDirectory("gateway-serve-"), (home) =>
  Effect.acquireRelease(
    Effect.promise(() => serveGateway({ home, port: 0, httpClient: FetchHttpClient.layer })),
    (running) => Effect.promise(() => running.stop())
  ))

describe("gateway service", () => {
  it.live("binds to loopback and answers health", () =>
    Effect.gen(function*() {
      const running = yield* gateway

      expect(running.url).toMatch(/^http:\/\/127\.0\.0\.1:/)
      expect((yield* HttpClient.get(`${running.url}/v1/health`)).status).toBe(200)

      const response = yield* HttpClient.get(`${running.url}/v1/metadata`)
      const metadata = Schema.decodeUnknownSync(GatewayMetadata)(yield* response.json)
      expect(metadata.gatewayVersion).toBe(gatewayVersion)
      expect(response.headers["cache-control"]).toBe("no-store")
    }).pipe(Effect.provide(services)))

  it.live("bootstraps separate local agent and operator clients", () =>
    Effect.gen(function*() {
      const running = yield* gateway

      const config = yield* Effect.promise(() => readGatewayConfig(running.service.home))
      const operatorConfig = yield* Effect.promise(() => readOperatorGatewayConfig(running.service.home))
      expect(config?.port).toBe(running.port)
      expect(config?.apiKey).toMatch(/^igk_/)
      expect(operatorConfig?.apiKey).toMatch(/^igk_/)
      expect(operatorConfig?.apiKey).not.toBe(config?.apiKey)

      const operator = yield* running.service.store.findClientByName(
        defaultTenantId,
        localClientName
      )
      const agent = yield* running.service.store.findClientByName(defaultTenantId, localAgentClientName)
      expect(operator?.capabilities).toEqual(["provision_connections", "administer_gateway"])
      expect(agent?.capabilities).toEqual(["provision_connections"])

      const denied = yield* HttpClient.get(`${running.url}/v1/clients`, {
        headers: { authorization: `Bearer ${config?.apiKey ?? ""}` }
      })
      expect(denied.status).toBe(403)
      const allowed = yield* HttpClient.get(`${running.url}/v1/clients`, {
        headers: { authorization: `Bearer ${operatorConfig?.apiKey ?? ""}` }
      })
      expect(allowed.status).toBe(200)
    }).pipe(Effect.provide(services)))

  it.live("writes the config file as a credential, not world-readable", () =>
    Effect.gen(function*() {
      const running = yield* gateway
      const fs = yield* FileSystem.FileSystem

      const info = yield* Effect.orDie(fs.stat(gatewayConfigPath(running.service.home)))
      const operatorInfo = yield* Effect.orDie(fs.stat(operatorGatewayConfigPath(running.service.home)))

      expect(Number(info.mode) & 0o777).toBe(0o600)
      expect(Number(operatorInfo.mode) & 0o777).toBe(0o600)
    }).pipe(Effect.provide(services)))

  it.live("revokes the former local keys when the gateway restarts", () =>
    Effect.gen(function*() {
      const home = yield* temporaryDirectory("gateway-restart-")
      const first = yield* Effect.acquireRelease(
        Effect.promise(() => serveGateway({ home, port: 0, httpClient: FetchHttpClient.layer })),
        (running) => Effect.promise(() => running.stop())
      )
      const oldAgent = yield* Effect.promise(() => readGatewayConfig(home))
      const oldOperator = yield* Effect.promise(() => readOperatorGatewayConfig(home))
      yield* Effect.promise(() => first.stop())

      const second = yield* Effect.acquireRelease(
        Effect.promise(() => serveGateway({ home, port: 0, httpClient: FetchHttpClient.layer })),
        (running) => Effect.promise(() => running.stop())
      )
      for (const key of [oldAgent?.apiKey, oldOperator?.apiKey]) {
        const response = yield* HttpClient.get(`${second.url}/v1/clients`, {
          headers: { authorization: `Bearer ${key ?? ""}` }
        })
        expect(response.status).toBe(401)
      }
    }).pipe(Effect.provide(services)))

  it.live("the control plane's own page is authenticated, a page on another site is not", () =>
    Effect.gen(function*() {
      const running = yield* gateway

      const ownPage = yield* HttpClient.get(`${running.url}/v1/clients`, {
        headers: { "sec-fetch-site": "same-origin" }
      })
      expect(ownPage.status).toBe(200)

      const elsewhere = yield* HttpClient.get(`${running.url}/v1/clients`, {
        headers: { "sec-fetch-site": "cross-site", origin: "https://evil.example.com" }
      })
      expect(elsewhere.status).toBe(401)
    }).pipe(Effect.provide(services)))

  it.live("an explicit key wins over the ambient one", () =>
    Effect.gen(function*() {
      const running = yield* gateway
      const store = running.service.store
      const local = yield* store.findClientByName(defaultTenantId, localClientName)
      if (local === undefined) throw new Error("Local client was not bootstrapped")
      const sandbox = yield* store.createClient({
        id: yield* newClientId,
        tenantId: defaultTenantId,
        accessProfileId: local.accessProfileId,
        approvalPolicyId: local.approvalPolicyId,
        name: "sandbox",
        capabilities: ["provision_connections"]
      })
      const key = yield* generateApiKey
      yield* store.addApiKey({ id: key.id, clientId: sandbox.id, hash: key.hash })

      const response = yield* HttpClient.get(`${running.url}/v1/clients`, {
        headers: { "sec-fetch-site": "same-origin", authorization: `Bearer ${key.secret}` }
      })

      expect(response.status).toBe(403)
    }).pipe(Effect.provide(services)))

  it.live("prefers an explicit environment over the local config file", () =>
    Effect.gen(function*() {
      const running = yield* gateway

      const fromFile = yield* Effect.promise(() =>
        resolveClientConnection({ INTEGRATIONS_HOME: running.service.home }))
      const operatorFromFile = yield* Effect.promise(() =>
        resolveOperatorConnection({ INTEGRATIONS_HOME: running.service.home }))
      const fromEnvironment = yield* Effect.promise(() =>
        resolveClientConnection({
          INTEGRATIONS_HOME: running.service.home,
          INTEGRATIONS_URL: "https://gateway.example",
          INTEGRATIONS_API_KEY: "igk_remote"
        }))

      expect(fromFile?.url).toBe(running.url)
      expect(operatorFromFile?.url).toBe(running.url)
      expect(operatorFromFile?.apiKey).not.toBe(fromFile?.apiKey)
      expect(fromEnvironment?.url).toBe("https://gateway.example")
      expect(fromEnvironment?.apiKey).toBe("igk_remote")
    }).pipe(Effect.provide(services)))

  it.live("reports no connection when neither environment nor config exists", () =>
    Effect.gen(function*() {
      const home = yield* temporaryDirectory("gateway-empty-")

      expect(yield* Effect.promise(() =>
        resolveClientConnection({ INTEGRATIONS_HOME: home }))).toBeUndefined()
      expect(yield* Effect.promise(() =>
        resolveOperatorConnection({ INTEGRATIONS_HOME: home }))).toBeUndefined()
    }).pipe(Effect.provide(services)))
})
