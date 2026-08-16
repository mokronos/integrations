import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  gatewayConfigPath,
  localClientName,
  readGatewayConfig,
  resolveClientConnection,
  serveGateway
} from "../src/index.ts"
import type { RunningGateway } from "../src/index.ts"

const directories: Array<string> = []
const running: Array<RunningGateway> = []

afterEach(async () => {
  await Promise.all(running.splice(0).map((gateway) => gateway.stop()))
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

const start = async (): Promise<RunningGateway> => {
  const home = await mkdtemp(path.join(tmpdir(), "wf-gateway-serve-"))
  directories.push(home)
  // Port 0 lets the OS pick, so tests never collide with a running daemon.
  const gateway = await serveGateway({ home, port: 0 })
  running.push(gateway)
  return gateway
}

describe("gateway service", () => {
  test("binds to loopback and answers health", async () => {
    const gateway = await start()

    expect(gateway.url).toStartWith("http://127.0.0.1:")
    const response = await fetch(`${gateway.url}/v1/health`)
    expect(response.status).toBe(200)
  })

  test("bootstraps a local client that may mutate, and records its key", async () => {
    const gateway = await start()

    const config = await readGatewayConfig(gateway.service.home)
    expect(config?.port).toBe(gateway.port)
    expect(config?.apiKey).toStartWith("wfi_")

    const local = await gateway.service.store.findClientByName(localClientName)
    // The local machine's own key is the admin credential: this is what lets an
    // agent discover and connect with the human needed only for auth.
    expect(local?.mayMutate).toBe(true)
  })

  test("writes the config file as a credential, not world-readable", async () => {
    const gateway = await start()

    const info = await stat(gatewayConfigPath(gateway.service.home))

    expect(info.mode & 0o777).toBe(0o600)
  })

  test("the recorded key actually works over the wire", async () => {
    const gateway = await start()
    const config = await readGatewayConfig(gateway.service.home)

    const response = await fetch(`${gateway.url}/v1/clients`, {
      headers: { authorization: `Bearer ${config?.apiKey ?? ""}` }
    })

    expect(response.status).toBe(200)
  })

  test("rejects a request with no credential over the wire", async () => {
    const gateway = await start()
    expect((await fetch(`${gateway.url}/v1/clients`)).status).toBe(401)
  })

  test("prefers an explicit environment over the local config file", async () => {
    const gateway = await start()

    const fromFile = await resolveClientConnection({ INTEGRATIONS_HOME: gateway.service.home })
    const fromEnvironment = await resolveClientConnection({
      INTEGRATIONS_HOME: gateway.service.home,
      INTEGRATIONS_URL: "https://gateway.example",
      INTEGRATIONS_API_KEY: "wfi_remote"
    })

    expect(fromFile?.url).toBe(gateway.url)
    // A sandbox is pointed at a remote gateway without touching disk.
    expect(fromEnvironment?.url).toBe("https://gateway.example")
    expect(fromEnvironment?.apiKey).toBe("wfi_remote")
  })

  test("reports no connection when neither environment nor config exists", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "wf-gateway-empty-"))
    directories.push(home)

    expect(await resolveClientConnection({ INTEGRATIONS_HOME: home })).toBeUndefined()
  })
})
