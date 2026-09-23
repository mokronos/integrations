/**
 * A disposable gateway + dashboard + fixture MCP server, isolated from ~/.integrations.
 *
 *   bun run scripts/test-env.ts up [--home <dir>] [--no-seed]   start (or restart) and print the environment
 *   bun run scripts/test-env.ts status --home <dir>              print what is still running
 *   bun run scripts/test-env.ts screenshot --home <dir> <path> [--width 1280 --height 800]
 *                                                                save a headless screenshot of a dashboard route
 *   bun run scripts/test-env.ts down --home <dir> [--remove]     stop what `up` started
 *
 * `up` writes <home>/test-env.json; every later command reads its PIDs and ports from there.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { readlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Schema } from "effect"

const root = path.resolve(import.meta.dirname, "..")

const Environment = Schema.Struct({
  home: Schema.String,
  gateway: Schema.Struct({ url: Schema.String, pid: Schema.Number }),
  dashboard: Schema.Struct({ url: Schema.String, pid: Schema.Number }),
  fixture: Schema.Struct({ url: Schema.String, pid: Schema.Number }),
  traces: Schema.String
})
type Environment = typeof Environment.Type

const decodeEnvironment = Schema.decodeUnknownSync(Schema.fromJsonString(Environment))

const flag = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

const freePort = (): number => {
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } })
  const port = probe.port
  probe.stop(true)
  return port
}

const spawn = (command: ReadonlyArray<string>, options: { cwd: string; log: string; env?: Record<string, string> }) => {
  const child = Bun.spawn([...command], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdin: "ignore",
    stdout: Bun.file(options.log),
    stderr: Bun.file(options.log)
  })
  child.unref()
  return child.pid
}

const waitFor = async (url: string, what: string): Promise<void> => {
  for (let attempt = 0; attempt < 120; attempt++) {
    const answered = await fetch(url).then(() => true, () => false)
    if (answered) return
    await Bun.sleep(250)
  }
  throw new Error(`${what} did not come up at ${url}; see its log in the home directory`)
}

const cli = async (program: "agent" | "main", args: ReadonlyArray<string>, home: string): Promise<string> => {
  const child = Bun.spawn(["bun", "run", `apps/cli/src/${program}.ts`, ...args], {
    cwd: root,
    env: { ...process.env, INTEGRATIONS_HOME: home },
    stdout: "pipe",
    stderr: "pipe"
  })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(`${program === "agent" ? "i" : "ii"} ${args.join(" ")} failed: ${err || out}`)
  return out
}

/** Only a process we started, still running from where we started it, is ours to stop. */
const alive = (pid: number, cwd: string): boolean => {
  try {
    return readlinkSync(`/proc/${pid}/cwd`) === cwd
  } catch {
    return false
  }
}

const stop = async (environment: Environment): Promise<void> => {
  const owned: ReadonlyArray<readonly [number, string]> = [
    [environment.gateway.pid, root],
    [environment.fixture.pid, root],
    [environment.dashboard.pid, path.join(root, "apps/web")]
  ]
  for (const [pid, cwd] of owned) {
    if (alive(pid, cwd)) process.kill(pid, "SIGTERM")
  }
  for (let attempt = 0; attempt < 40 && owned.some(([pid, cwd]) => alive(pid, cwd)); attempt++) {
    await Bun.sleep(250)
  }
}

const read = async (home: string): Promise<Environment> =>
  decodeEnvironment(await readFile(path.join(home, "test-env.json"), "utf8"))

const seed = async (home: string, fixtureUrl: string): Promise<void> => {
  await cli("agent", ["discover", `${fixtureUrl}/mcp`], home)
  // A tool in an access profile without an approval decision fails every tool listing, so grant both.
  await cli("main", ["access-profile-tool", "default-access-profile:default", "fixture", "echo"], home)
  await cli("main", ["approval-policy-tool", "default-approval-policy:default", "fixture", "echo", "allow"], home)
}

const up = async (): Promise<void> => {
  const home = path.resolve(flag("--home") ?? await mkdtemp(path.join(tmpdir(), "integrations-test.")))
  const previous = await read(home).catch(() => undefined)
  if (previous !== undefined) await stop(previous)
  await mkdir(home, { recursive: true })

  // A restart keeps its ports: the seeded integration remembers the fixture's URL.
  const portOf = (url: string | undefined) => url === undefined ? freePort() : Number(new URL(url).port)
  const gatewayPort = portOf(previous?.gateway.url)
  const dashboardPort = portOf(previous?.dashboard.url)
  const fixturePort = portOf(previous?.fixture.url)
  const gateway = `http://127.0.0.1:${gatewayPort}`
  const dashboard = `http://127.0.0.1:${dashboardPort}`
  const fixture = `http://127.0.0.1:${fixturePort}`

  const environment: Environment = {
    home,
    gateway: {
      url: gateway,
      pid: spawn(["bun", "run", "apps/cli/src/main.ts", "serve", "--port", String(gatewayPort)], {
        cwd: root,
        log: path.join(home, "gateway.log"),
        env: { INTEGRATIONS_HOME: home, INTEGRATIONS_WEB_DIR: path.join(root, "apps/web/dist") }
      })
    },
    fixture: {
      url: fixture,
      pid: spawn(["bun", "run", "scripts/fixture-mcp.ts", String(fixturePort)], { cwd: root, log: path.join(home, "fixture.log") })
    },
    dashboard: {
      url: dashboard,
      pid: spawn(["bun", "node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", String(dashboardPort), "--strictPort"], {
        cwd: path.join(root, "apps/web"),
        log: path.join(home, "dashboard.log"),
        env: { INTEGRATIONS_URL: gateway }
      })
    },
    traces: path.join(home, "logs")
  }
  await writeFile(path.join(home, "test-env.json"), JSON.stringify(environment, null, 2))

  await waitFor(`${gateway}/v1/health`, "the gateway")
  // The CLIs find the gateway through the credential it writes once it is listening.
  for (let attempt = 0; attempt < 120 && !(await Bun.file(path.join(home, "gateway.json")).exists()); attempt++) {
    await Bun.sleep(250)
  }
  await waitFor(`${fixture}/mcp`, "the fixture MCP server")
  await waitFor(dashboard, "the dashboard")
  if (previous === undefined && !process.argv.includes("--no-seed")) await seed(home, fixture)

  console.log(JSON.stringify(environment, null, 2))
}

const status = async (): Promise<void> => {
  const home = flag("--home")
  if (home === undefined) throw new Error("status needs --home <dir>")
  const environment = await read(path.resolve(home))
  const answers = (url: string) => fetch(url).then(() => true, () => false)
  const [gatewayUp, dashboardUp, fixtureUp] = await Promise.all([
    answers(`${environment.gateway.url}/v1/health`),
    answers(environment.dashboard.url),
    answers(`${environment.fixture.url}/mcp`)
  ])
  console.log(JSON.stringify({ ...environment, gatewayUp, dashboardUp, fixtureUp }, null, 2))
}

const screenshot = async (): Promise<void> => {
  const home = flag("--home")
  if (home === undefined) throw new Error("screenshot needs --home <dir>")
  const environment = await read(path.resolve(home))
  const route = process.argv.slice(3).find((argument, index, all) =>
    argument.startsWith("/") && !(all[index - 1] ?? "").startsWith("--")) ?? "/"
  const browser = Bun.which("chromium") ?? Bun.which("google-chrome-stable") ?? Bun.which("google-chrome")
  if (browser === null) throw new Error("no chromium or google-chrome on PATH")
  const output = path.join(environment.home, "shots", `${route === "/" ? "overview" : route.slice(1).replaceAll("/", "-")}-${Date.now()}.png`)
  await mkdir(path.dirname(output), { recursive: true })
  const child = Bun.spawn([
    browser,
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    `--user-data-dir=${path.join(environment.home, "browser")}`,
    `--window-size=${flag("--width") ?? "1280"},${flag("--height") ?? "800"}`,
    "--virtual-time-budget=8000",
    `--screenshot=${output}`,
    `${environment.dashboard.url}${route}`
  ], { stdout: "ignore", stderr: "ignore" })
  if (await child.exited !== 0 || !(await Bun.file(output).exists())) throw new Error(`${browser} did not write ${output}`)
  console.log(output)
}

const down = async (): Promise<void> => {
  const home = flag("--home")
  if (home === undefined) throw new Error("down needs --home <dir>")
  const resolved = path.resolve(home)
  await stop(await read(resolved))
  if (process.argv.includes("--remove")) {
    if (!path.basename(resolved).startsWith("integrations-test.")) {
      throw new Error(`refusing to remove ${resolved}: only homes created by \`up\` are removed`)
    }
    await rm(resolved, { recursive: true, force: true })
  }
  console.log(`stopped the environment in ${resolved}`)
}

const command = (() => {
  switch (process.argv[2]) {
    case "up": return up
    case "status": return status
    case "screenshot": return screenshot
    case "down": return down
    default: return undefined
  }
})()
if (command === undefined) {
  console.error("usage: bun run scripts/test-env.ts up|status|screenshot|down [--home <dir>]")
  process.exitCode = 1
} else {
  await command().catch((error: Error) => {
    console.error(`error: ${error.message}`)
    process.exitCode = 1
  })
}
