import { describe, expect, it } from "@effect/vitest"
import path from "node:path"
import { Effect, Layer, Schedule } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { temporaryDirectory, testServices } from "./fixtures.ts"

const repoRoot = path.resolve(import.meta.dirname, "../../..")
const cliPath = path.join(repoRoot, "apps", "cli", "src", "main.ts")

const services = Layer.merge(testServices, FetchHttpClient.layer)

const run = (args: ReadonlyArray<string>, home: string) =>
  Effect.promise(async () => {
    const subprocess = Bun.spawn({
      cmd: [process.execPath, "run", cliPath, ...args],
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, INTEGRATIONS_HOME: home, NO_COLOR: "1" }
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      subprocess.exited,
      new Response(subprocess.stdout).text(),
      new Response(subprocess.stderr).text()
    ])
    return { exitCode, stdout, stderr }
  })

const freePort = Effect.sync(() => {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") })
  const port = Number(server.port)
  server.stop(true)
  return port
})

/** A pid the test's scope signals, whichever way the test itself ends. */
const reaped = (pid: number) =>
  Effect.addFinalizer(() =>
    Effect.sync(() => {
      try {
        process.kill(pid, "SIGTERM")
      } catch {
        // already gone, which is what the test wanted anyway
      }
    }))

describe("integrations serve --detach", () => {
  it.live("returns a usable gateway that outlives the launching process", () =>
    Effect.gen(function*() {
      const home = yield* temporaryDirectory("integrations-detach-")
      const port = yield* freePort

      const detached = yield* run(["serve", "--detach", "--port", String(port)], home)
      expect(`detach exit ${detached.exitCode}: ${detached.stderr}`).toBe("detach exit 0: ")
      const pid = Number(/\(pid (\d+)\)/.exec(detached.stdout)?.[1])
      expect(Number.isInteger(pid)).toBe(true)
      yield* reaped(pid)
      expect(detached.stdout).toContain(`http://127.0.0.1:${port}`)

      const listed = yield* run(["integrations"], home)
      expect(`integrations exit ${listed.exitCode}: ${listed.stderr}`)
        .toBe("integrations exit 0: ")
      expect(JSON.parse(listed.stdout)).toMatchObject({ integrations: [] })

      const second = yield* run(["serve", "--detach", "--port", String(port)], home)
      expect(second.exitCode).toBe(1)
      expect(second.stderr).toContain("already listening")

      yield* Effect.sync(() => process.kill(pid, "SIGTERM"))
      const closed = yield* Effect.retry(
        Effect.flip(HttpClient.get(`http://127.0.0.1:${port}`)),
        { schedule: Schedule.spaced("50 millis"), times: 40 }
      ).pipe(Effect.option)
      expect(closed._tag).toBe("Some")
    }).pipe(Effect.provide(services)), 40_000)
})
