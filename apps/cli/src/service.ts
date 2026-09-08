import { closeSync, openSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { homedir, userInfo } from "node:os"
import path from "node:path"
import { Data, Effect } from "effect"
import { HttpClient } from "effect/unstable/http"
import { defaultGatewayPort, integrationsHome, readGatewayConfig } from "@mokronos/integrations-client"

export class ServiceError extends Data.TaggedError("ServiceError")<{
  readonly message: string
}> {}

export {
  launchdPlist,
  serviceArguments,
  serviceErrorLogPath,
  serviceLabel,
  serviceLogPath,
  systemdQuote,
  systemdUnit,
  type ServiceDescriptor,
  type SystemdUnitOptions
} from "./service-descriptors.ts"
import {
  launchdPlist,
  serviceArguments,
  serviceErrorLogPath,
  serviceLabel,
  serviceLogPath,
  systemdUnit,
  type ServiceDescriptor
} from "./service-descriptors.ts"

export const serviceIsRegistered = async (): Promise<boolean> => {
  const definition = process.platform === "darwin"
    ? path.join(homedir(), "Library", "LaunchAgents", `${serviceLabel}.plist`)
    : path.join(homedir(), ".config", "systemd", "user", `${serviceLabel}.service`)
  return await Bun.file(definition).exists()
}

const command = async (
  program: string,
  arguments_: ReadonlyArray<string>,
  verbose: boolean
): Promise<void> => {
  const process_ = Bun.spawn([program, ...arguments_], {
    stdout: verbose ? "inherit" : "pipe",
    stderr: verbose ? "inherit" : "pipe"
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    process_.exited,
    verbose ? Promise.resolve("") : new Response(process_.stdout).text(),
    verbose ? Promise.resolve("") : new Response(process_.stderr).text()
  ])
  if (exitCode !== 0) {
    const details = [stdout.trim(), stderr.trim()].filter((line) => line.length > 0).join("\n")
    const limit = 800
    const bounded = details.length <= limit
      ? details
      : `${details.slice(0, limit)}… (+${details.length - limit} chars)`
    throw new Error(
      `${program} ${arguments_.join(" ")} failed${bounded.length === 0 ? "" : `:\n${bounded}`}`
    )
  }
}

const launchdTarget = (): string => `gui/${process.getuid?.() ?? userInfo().uid}`

const unsupportedPlatform = (verb: string): ServiceError =>
  new ServiceError({
    message:
      `ii ${verb} currently supports Linux systemd --user and macOS launchd (this is ${process.platform})`
  })

const attempt = <A>(work: () => Promise<A>): Effect.Effect<A, ServiceError> =>
  Effect.tryPromise({
    try: work,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters
    catch: (cause: unknown) =>
      new ServiceError({ message: cause instanceof Error ? cause.message : String(cause) })
  })

const installedAndReady = Effect.fn("service.installedAndReady")(function*(
  descriptor: ServiceDescriptor,
  previousKey: string | undefined,
  statusCommand: string
): Effect.fn.Return<ServiceDescriptor, ServiceError, HttpClient.HttpClient> {
  const ready = yield* waitUntilReady({
    home: descriptor.home,
    base: probeBase("127.0.0.1", descriptor.port),
    previousKey
  })
  if (ready) return descriptor
  return yield* new ServiceError({
    message:
      `${serviceLabel} was registered but did not answer within ${readyTimeoutMs / 1_000}s.\nCheck: ${statusCommand}\nLog: ${serviceErrorLogPath(descriptor.home)}`
  })
})

export interface InstallOptions {
  readonly program: ReadonlyArray<string>
  readonly port?: number
  readonly verbose?: boolean
}

export const installService = Effect.fn("service.install")(function*(
  options: InstallOptions
): Effect.fn.Return<ServiceDescriptor, ServiceError, HttpClient.HttpClient> {
  const home = integrationsHome()
  const verbose = options.verbose ?? false
  const descriptor: ServiceDescriptor = {
    program: options.program,
    home,
    port: options.port ?? defaultGatewayPort
  }
  const previousKey = yield* attempt(async () => {
    await mkdir(path.join(home, "logs"), { recursive: true })
    return await recordedKey(home)
  })
  if (process.platform === "linux") {
    yield* attempt(async () => {
      const unitDirectory = path.join(homedir(), ".config", "systemd", "user")
      await mkdir(unitDirectory, { recursive: true })
      await writeFile(
        path.join(unitDirectory, `${serviceLabel}.service`),
        systemdUnit({
          program: serviceArguments(descriptor),
          environment: { INTEGRATIONS_HOME: home },
          workingDirectory: home,
          stdoutPath: serviceLogPath(home),
          stderrPath: serviceErrorLogPath(home)
        }),
        { mode: 0o600 }
      )
      await command("systemctl", ["--user", "daemon-reload"], verbose)
      await command("systemctl", ["--user", "enable", `${serviceLabel}.service`], verbose)
      await command("systemctl", ["--user", "restart", `${serviceLabel}.service`], verbose)
      await command("loginctl", ["enable-linger", userInfo().username], verbose)
        .catch(() => undefined)
    })
    return yield* installedAndReady(
      descriptor,
      previousKey,
      `systemctl --user status ${serviceLabel}`
    )
  }
  if (process.platform === "darwin") {
    const plist = path.join(homedir(), "Library", "LaunchAgents", `${serviceLabel}.plist`)
    yield* attempt(async () => {
      await mkdir(path.dirname(plist), { recursive: true })
      await writeFile(plist, launchdPlist(descriptor), { mode: 0o600 })
      await command("launchctl", ["bootout", `${launchdTarget()}/${serviceLabel}`], verbose)
        .catch(() => undefined)
      await command("launchctl", ["bootstrap", launchdTarget(), plist], verbose)
    })
    return yield* installedAndReady(
      descriptor,
      previousKey,
      `launchctl print ${launchdTarget()}/${serviceLabel}`
    )
  }
  return yield* unsupportedPlatform("install")
})

export const stopService = async (verbose = false): Promise<void> => {
  if (process.platform === "linux") {
    await command("systemctl", ["--user", "stop", `${serviceLabel}.service`], verbose)
      .catch(() => undefined)
    return
  }
  if (process.platform === "darwin") {
    await command("launchctl", ["bootout", `${launchdTarget()}/${serviceLabel}`], verbose)
      .catch(() => undefined)
    return
  }
  throw unsupportedPlatform("stop")
}

export const uninstallService = async (verbose = false): Promise<void> => {
  if (process.platform === "linux") {
    await command("systemctl", ["--user", "disable", "--now", `${serviceLabel}.service`], verbose)
      .catch(() => undefined)
    await Bun.file(
      path.join(homedir(), ".config", "systemd", "user", `${serviceLabel}.service`)
    ).delete().catch(() => undefined)
    await command("systemctl", ["--user", "daemon-reload"], verbose)
    return
  }
  if (process.platform === "darwin") {
    await command("launchctl", ["bootout", `${launchdTarget()}/${serviceLabel}`], verbose)
      .catch(() => undefined)
    await Bun.file(path.join(homedir(), "Library", "LaunchAgents", `${serviceLabel}.plist`))
      .delete().catch(() => undefined)
    return
  }
  throw unsupportedPlatform("uninstall")
}

export const serviceProgram = (): ReadonlyArray<string> =>
  Bun.main.startsWith("/$bunfs/") || Bun.main.startsWith("B:\\~BUN\\")
    ? [process.execPath]
    : [process.execPath, Bun.main]

const probeBase = (host: string, port: number): string =>
  `http://${host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host}:${port}`

const responds = Effect.fn("service.responds")((base: string) =>
  HttpClient.get(base).pipe(
    Effect.timeout(1_000),
    Effect.match({ onFailure: () => false, onSuccess: () => true })
  )
)

const isReady = Effect.fn("service.isReady")(function*(
  home: string,
  base: string,
  previousKey: string | undefined
): Effect.fn.Return<boolean, never, HttpClient.HttpClient> {
  const config = yield* Effect.promise(() => readGatewayConfig(home))
  if (config === undefined || config.apiKey === previousKey) return false
  return yield* HttpClient.get(`${base}/v1/integrations`, {
    headers: { authorization: `Bearer ${config.apiKey}` }
  }).pipe(
    Effect.timeout(1_000),
    Effect.match({ onFailure: () => false, onSuccess: (response) => response.status === 200 })
  )
})

const logTail = async (location: string, lines = 15): Promise<string> => {
  const text = await Bun.file(location).text().catch(() => "")
  return text.trimEnd().split("\n").slice(-lines).join("\n")
}

const readyTimeoutMs = 20_000
const readyIntervalMs = 150

interface WaitOptions {
  readonly home: string
  readonly base: string
  readonly previousKey: string | undefined
  readonly exitCode?: () => number | undefined
}

const waitUntilReady = Effect.fn("service.waitUntilReady")(function*(
  options: WaitOptions
): Effect.fn.Return<boolean, never, HttpClient.HttpClient> {
  for (let waited = 0; waited < readyTimeoutMs; waited += readyIntervalMs) {
    if (options.exitCode?.() !== undefined) return false
    if (yield* isReady(options.home, options.base, options.previousKey)) return true
    yield* Effect.sleep(readyIntervalMs)
  }
  return false
})

const recordedKey = async (home: string): Promise<string | undefined> =>
  (await readGatewayConfig(home))?.apiKey

export interface DetachOptions {
  readonly program: ReadonlyArray<string>
  readonly port: number
  readonly host: string
}

export interface DetachedGateway {
  readonly pid: number
  readonly url: string
  readonly logPath: string
}

export const startDetachedGateway = Effect.fn("service.startDetached")(function*(
  options: DetachOptions
): Effect.fn.Return<DetachedGateway, ServiceError, HttpClient.HttpClient> {
  const home = integrationsHome()
  const base = probeBase(options.host, options.port)
  if (yield* responds(base)) {
    return yield* new ServiceError({
      message: `Something is already listening at ${base}. Stop it, or pass a different --port.`
    })
  }
  const logPath = serviceLogPath(home)
  const errorPath = serviceErrorLogPath(home)
  const spawned = yield* attempt(async () => {
    const previousKey = await recordedKey(home)
    await mkdir(path.join(home, "logs"), { recursive: true })
    const stdout = openSync(logPath, "a")
    const stderr = openSync(errorPath, "a")
    const child = Bun.spawn(
      [...options.program, "serve", "--port", String(options.port), "--host", options.host],
      { cwd: home, stdin: "ignore", stdout, stderr }
    )
    closeSync(stdout)
    closeSync(stderr)
    child.unref()
    return { child, previousKey }
  })
  let exitCode: number | undefined
  void spawned.child.exited.then((code) => {
    exitCode = code
  })
  const ready = yield* waitUntilReady({
    home,
    base,
    previousKey: spawned.previousKey,
    exitCode: () => exitCode
  })
  if (ready) return { pid: spawned.child.pid, url: base, logPath }
  if (exitCode !== undefined) {
    const tail = yield* Effect.promise(() => logTail(errorPath))
    return yield* new ServiceError({
      message:
        `The gateway exited immediately (code ${exitCode}).${tail.length === 0 ? "" : `\n${tail}`}`
    })
  }
  return yield* new ServiceError({
    message:
      `The gateway did not become ready within ${readyTimeoutMs / 1_000}s. It is still running as pid ${spawned.child.pid}; see ${logPath}`
  })
})

export interface StoppedGateway {
  readonly pid: number
  readonly url: string
  readonly forced: boolean
}

const stopTimeoutMs = 10_000

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const capture = async (
  program: string,
  arguments_: ReadonlyArray<string>
): Promise<string | undefined> => {
  try {
    const process_ = Bun.spawn([program, ...arguments_], { stdout: "pipe", stderr: "ignore" })
    const [exitCode, stdout] = await Promise.all([
      process_.exited,
      new Response(process_.stdout).text()
    ])
    return exitCode === 0 ? stdout : undefined
  } catch {
    return undefined
  }
}

const processCommand = async (pid: number): Promise<string | undefined> => {
  if (process.platform === "linux") {
    const raw = await Bun.file(`/proc/${pid}/cmdline`).text().catch(() => undefined)
    return raw === undefined ? undefined : raw.replaceAll("\0", " ").trim()
  }
  return (await capture("ps", ["-o", "command=", "-p", String(pid)]))?.trim()
}

const listeningPid = async (port: number): Promise<number | undefined> => {
  const fromLsof = await capture("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"])
  const firstLine = fromLsof?.trim().split("\n")[0]?.trim()
  if (firstLine !== undefined && /^\d+$/.test(firstLine)) return Number(firstLine)
  const fromSs = await capture("ss", ["-tlnpH", `sport = :${port}`])
  const matched = fromSs?.match(/pid=(\d+)/)?.[1]
  return matched === undefined ? undefined : Number(matched)
}

const waitUntilStopped = Effect.fn("service.waitUntilStopped")(function*(
  base: string
): Effect.fn.Return<boolean, never, HttpClient.HttpClient> {
  for (let waited = 0; waited < stopTimeoutMs; waited += readyIntervalMs) {
    if (!(yield* responds(base))) return true
    yield* Effect.sleep(readyIntervalMs)
  }
  return false
})

export const stopGateway = Effect.fn("service.stopGateway")(function*(): Effect.fn.Return<
  StoppedGateway | undefined,
  ServiceError,
  HttpClient.HttpClient
> {
  const home = integrationsHome()
  const config = yield* Effect.promise(() => readGatewayConfig(home))
  const port = config?.port ?? defaultGatewayPort
  const base = config?.url ?? probeBase("127.0.0.1", port)
  if (!(yield* responds(base))) return undefined

  const recorded = config?.pid
  const pid = recorded !== undefined && isAlive(recorded)
    ? recorded
    : yield* Effect.promise(() => listeningPid(port))
  if (pid === undefined) {
    return yield* new ServiceError({
      message:
        `A gateway is answering at ${base}, but nothing on this machine could say which process it is. Stop it where you started it, then run this again.`
    })
  }
  const command = yield* Effect.promise(() => processCommand(pid))
  if (command !== undefined && !command.includes("serve")) {
    return yield* new ServiceError({
      message: `Refusing to stop pid ${pid}: its command line is not a gateway (${command}).`
    })
  }

  yield* Effect.try({
    try: () => process.kill(pid, "SIGTERM"),
    // oxlint-disable-next-line anti-slop/no-unknown-parameters
    catch: (cause: unknown) =>
      new ServiceError({
        message: `Could not signal pid ${pid}: ${cause instanceof Error ? cause.message : String(cause)}`
      })
  })
  if (yield* waitUntilStopped(base)) return { pid, url: base, forced: false }

  if (isAlive(pid)) process.kill(pid, "SIGKILL")
  if (yield* waitUntilStopped(base)) return { pid, url: base, forced: true }
  return yield* new ServiceError({
    message: `Pid ${pid} was signalled but ${base} is still answering after ${stopTimeoutMs / 1_000}s.`
  })
})
