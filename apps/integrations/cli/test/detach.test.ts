import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test } from "bun:test"

const repoRoot = path.resolve(import.meta.dir, "../../../..")
const cliPath = path.join(repoRoot, "apps", "integrations", "cli", "src", "main.ts")

const started: Array<number> = []
const directories: Array<string> = []

afterEach(async () => {
  for (const pid of started.splice(0)) {
    try {
      process.kill(pid, "SIGTERM")
    } catch {
      // Already gone: the test either killed it or it never came up.
    }
  }
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

const run = async (args: ReadonlyArray<string>, home: string) => {
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
}

/** Asking the OS for a port and releasing it, so a detached gateway on a busy
 *  machine does not collide with the real one on 4788. */
const freePort = (): number => {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") })
  const port = Number(server.port)
  server.stop(true)
  return port
}

const temporaryHome = async (): Promise<string> => {
  const home = await mkdtemp(path.join(os.tmpdir(), "integrations-detach-"))
  directories.push(home)
  return home
}

describe("integrations serve --detach", () => {
  test("returns a usable gateway that outlives the launching process", async () => {
    const home = await temporaryHome()
    const port = freePort()

    const detached = await run(["serve", "--detach", "--port", String(port)], home)

    expect(`detach exit ${detached.exitCode}: ${detached.stderr}`).toBe("detach exit 0: ")
    const pid = Number(/\(pid (\d+)\)/.exec(detached.stdout)?.[1])
    expect(Number.isInteger(pid)).toBe(true)
    started.push(pid)
    expect(detached.stdout).toContain(`http://127.0.0.1:${port}`)

    // The launcher has already exited: the gateway it left behind has to be
    // both alive and credentialed, which is what --detach promises.
    const listed = await run(["integrations"], home)
    expect(`integrations exit ${listed.exitCode}: ${listed.stderr}`).toBe(
      "integrations exit 0: "
    )
    expect(JSON.parse(listed.stdout)).toMatchObject({ integrations: [] })

    const second = await run(["serve", "--detach", "--port", String(port)], home)
    expect(second.exitCode).toBe(1)
    expect(second.stderr).toContain("already listening")

    process.kill(pid, "SIGTERM")
    started.splice(0)
    await Bun.sleep(500)
    expect(await fetch(`http://127.0.0.1:${port}`).catch(() => undefined)).toBeUndefined()
  }, 40_000)
})
