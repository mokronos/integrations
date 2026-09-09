import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { gatewayConfigPath } from "@mokronos/integrations-client"
import { whenPresent } from "@mokronos/contracts"
import { Effect, Layer, Result } from "effect"
import * as BunServices from "@effect/platform-bun/BunServices"
import type { ChildProcessSpawner } from "effect/unstable/process"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { stopGateway } from "../src/service.ts"

const run = <A, E>(effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner | HttpClient.HttpClient>): Promise<A> =>
  Effect.runPromise(effect.pipe(
    Effect.provide(Layer.merge(FetchHttpClient.layer, BunServices.layer))
  ))

const directories: Array<string> = []
const children: Array<Bun.Subprocess> = []
const previousHome = process.env["INTEGRATIONS_HOME"]

afterEach(async () => {
  for (const child of children.splice(0)) child.kill("SIGKILL")
  if (previousHome === undefined) delete process.env["INTEGRATIONS_HOME"]
  else process.env["INTEGRATIONS_HOME"] = previousHome
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

const temporaryHome = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "integrations-stop-"))
  directories.push(directory)
  process.env["INTEGRATIONS_HOME"] = directory
  return directory
}

const writeConfig = async (
  home: string,
  config: { readonly port: number; readonly pid?: number }
): Promise<void> => {
  await writeFile(
    gatewayConfigPath(home),
    JSON.stringify({
      port: config.port,
      url: `http://127.0.0.1:${config.port}`,
      apiKey: "wfi_test",
      ...whenPresent("pid", config.pid)
    })
  )
}

const closedPort = async (): Promise<number> => {
  const server = Bun.serve({ port: 0, fetch: () => new Response("ok") })
  const { port } = server
  await server.stop(true)
  if (port === undefined) throw new Error("Bun.serve did not report a port")
  return port
}

const startImpostor = async (home: string): Promise<{ port: number; pid: number }> => {
  const script = path.join(home, "impostor.ts")
  await writeFile(
    script,
    `const listener = Bun.serve({ port: 0, fetch: () => new Response("ok") })\n` +
      `console.log(listener.port)\n`
  )
  const child = Bun.spawn([process.execPath, script], { stdout: "pipe", stderr: "ignore" })
  children.push(child)
  const reader = child.stdout.getReader()
  const { value } = await reader.read()
  reader.releaseLock()
  const port = Number(new TextDecoder().decode(value).trim())
  return { port, pid: child.pid }
}

describe("stopGateway", () => {
  test("reports nothing to stop when the recorded port is closed", async () => {
    const home = await temporaryHome()
    await writeConfig(home, { port: await closedPort() })

    expect(await run(stopGateway())).toBeUndefined()
  })

  test("refuses to signal a process whose command line is not a gateway", async () => {
    const home = await temporaryHome()
    const impostor = await startImpostor(home)
    await writeConfig(home, { port: impostor.port, pid: impostor.pid })

    const outcome = await run(Effect.result(stopGateway()))
    expect(Result.isFailure(outcome)).toBe(true)
    expect(Result.isFailure(outcome) ? outcome.failure.message : "").toContain(
      `Refusing to stop pid ${impostor.pid}`
    )
    const alive = await run(HttpClient.get(`http://127.0.0.1:${impostor.port}`))
    expect(alive.status).toBe(200)
  })
})
