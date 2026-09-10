import { describe, expect, it } from "@effect/vitest"
import path from "node:path"
import { gatewayConfigPath } from "@mokronos/integrations-client"
import { whenPresent } from "@integrations/contracts"
import { Effect, FileSystem, Layer } from "effect"
import * as BunServices from "@effect/platform-bun/BunServices"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { stopGateway } from "../src/service.ts"
import { temporaryDirectory, testServices } from "./fixtures.ts"

const services = Layer.mergeAll(testServices, FetchHttpClient.layer, BunServices.layer)

/**
 * `stopGateway` reads the home directory from the environment, so each test
 * points it at its own and puts the previous value back afterwards.
 */
const temporaryHome = Effect.fnUntraced(function*() {
  const directory = yield* temporaryDirectory("integrations-stop-")
  const previous = process.env["INTEGRATIONS_HOME"]
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      if (previous === undefined) delete process.env["INTEGRATIONS_HOME"]
      else process.env["INTEGRATIONS_HOME"] = previous
    }))
  process.env["INTEGRATIONS_HOME"] = directory
  return directory
})

const writeConfig = Effect.fnUntraced(function*(
  home: string,
  config: { readonly port: number; readonly pid?: number }
) {
  const fs = yield* FileSystem.FileSystem
  yield* Effect.orDie(fs.writeFileString(
    gatewayConfigPath(home),
    JSON.stringify({
      port: config.port,
      url: `http://127.0.0.1:${config.port}`,
      apiKey: "wfi_test",
      ...whenPresent("pid", config.pid)
    })
  ))
})

/** A port nothing is listening on any more. */
const closedPort = Effect.sync(() => {
  const server = Bun.serve({ port: 0, fetch: () => new Response("ok") })
  const { port } = server
  server.stop(true)
  if (port === undefined) throw new Error("Bun.serve did not report a port")
  return port
})

/** A process holding a port that is not a gateway at all. */
const impostor = (home: string) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const script = path.join(home, "impostor.ts")
      await Bun.write(
        script,
        `const listener = Bun.serve({ port: 0, fetch: () => new Response("ok") })\n` +
          `console.log(listener.port)\n`
      )
      const child = Bun.spawn([process.execPath, script], { stdout: "pipe", stderr: "ignore" })
      const reader = child.stdout.getReader()
      const { value } = await reader.read()
      reader.releaseLock()
      return { port: Number(new TextDecoder().decode(value).trim()), pid: child.pid, child }
    }),
    ({ child }) => Effect.sync(() => child.kill("SIGKILL"))
  )

describe("stopGateway", () => {
  it.live("reports nothing to stop when the recorded port is closed", () =>
    Effect.gen(function*() {
      const home = yield* temporaryHome()
      yield* writeConfig(home, { port: yield* closedPort })

      expect(yield* stopGateway()).toBeUndefined()
    }).pipe(Effect.provide(services)))

  it.live("refuses to signal a process whose command line is not a gateway", () =>
    Effect.gen(function*() {
      const home = yield* temporaryHome()
      const other = yield* impostor(home)
      yield* writeConfig(home, { port: other.port, pid: other.pid })

      const outcome = yield* Effect.result(stopGateway())

      expect(outcome._tag).toBe("Failure")
      expect(outcome._tag === "Failure" ? outcome.failure.message : "")
        .toContain(`Refusing to stop pid ${other.pid}`)
      expect((yield* HttpClient.get(`http://127.0.0.1:${other.port}`)).status).toBe(200)
    }).pipe(Effect.provide(services)))
})
