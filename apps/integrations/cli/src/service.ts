import { closeSync, openSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { homedir, userInfo } from "node:os"
import path from "node:path"
import { defaultGatewayPort, integrationsHome, readGatewayConfig } from "@mokronos/integrations-client"

/** Registering the gateway with the platform's per-user service manager.
 *
 * This deliberately repeats the shape of the dashboard's installer rather than
 * sharing it: `wf` depends on the gateway, not the other way round, so the
 * integrations app cannot import from the workflow CLI. The two units are also
 * genuinely different — a different label, home variable, port, and lifetime.
 * The gateway holds every credential and must survive the dashboard. */
export const serviceLabel = "dev.mokronos.integrations"

export const serviceLogPath = (home: string): string =>
  path.join(home, "logs", "integrations.log")
export const serviceErrorLogPath = (home: string): string =>
  path.join(home, "logs", "integrations.error.log")

export interface ServiceDescriptor {
  /** A program, not a single path: a compiled binary is one element, while a
   *  source install is ["<bun>", "<path to main.ts>"]. */
  readonly program: ReadonlyArray<string>
  readonly home: string
  readonly port: number
}

/** The arguments the unit runs. Loopback is not configurable here: a service
 *  that starts at login and exposes a credential-unlocking port to the network
 *  should be a deliberate `ii serve --host` in a terminal, not a
 *  default someone forgets is running. */
export const serviceArguments = (descriptor: ServiceDescriptor): ReadonlyArray<string> => [
  ...descriptor.program,
  "serve",
  "--port",
  String(descriptor.port)
]

export interface SystemdUnitOptions {
  readonly program: ReadonlyArray<string>
  readonly environment: Readonly<Record<string, string>>
  readonly workingDirectory: string
  readonly stdoutPath: string
  readonly stderrPath: string
}

const bareSystemdValue = /^[A-Za-z0-9_@%+=:,./-]+$/

export const systemdQuote = (value: string): string => {
  const escapedPercent = value.replaceAll("%", "%%")
  return bareSystemdValue.test(value)
    ? escapedPercent
    : `"${escapedPercent.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n")}"`
}

export const systemdUnit = (options: SystemdUnitOptions): string => {
  const command = options.program.map(systemdQuote).join(" ")
  const environment = Object.entries(options.environment)
    .map(([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}`)
    .join("\n")
  return `[Unit]
Description=integrations gateway
After=default.target

[Service]
Type=simple
ExecStart=${command}
${environment}
WorkingDirectory=${systemdQuote(options.workingDirectory)}
StandardOutput=${systemdQuote(`append:${options.stdoutPath}`)}
StandardError=${systemdQuote(`append:${options.stderrPath}`)}
Restart=on-failure
RestartSec=3s

[Install]
WantedBy=default.target
`
}

const xmlEscape = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")

export const launchdPlist = (descriptor: ServiceDescriptor): string => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${serviceLabel}</string>
  <key>ProgramArguments</key><array>
    ${serviceArguments(descriptor).map((value) => `<string>${xmlEscape(value)}</string>`).join("\n    ")}
  </array>
  <key>EnvironmentVariables</key><dict><key>INTEGRATIONS_HOME</key><string>${xmlEscape(descriptor.home)}</string></dict>
  <key>WorkingDirectory</key><string>${xmlEscape(descriptor.home)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xmlEscape(serviceLogPath(descriptor.home))}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(serviceErrorLogPath(descriptor.home))}</string>
</dict></plist>
`

/** Whether a service definition exists, so a command can say that the running
 *  gateway is older than the code on disk. Reads the definition rather than
 *  asking the service manager: the file is the registration. */
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

const unsupportedPlatform = (verb: string): Error =>
  new Error(
    `ii ${verb} currently supports Linux systemd --user and macOS launchd (this is ${process.platform})`
  )

/** The service manager reports success once it has spawned the process. What
 *  the caller asked for is a gateway that answers, so wait for that and point
 *  at the two places the reason would be if it never does. */
const installedAndReady = async (
  descriptor: ServiceDescriptor,
  previousKey: string | undefined,
  statusCommand: string
): Promise<ServiceDescriptor> => {
  const ready = await waitUntilReady({
    home: descriptor.home,
    base: probeBase("127.0.0.1", descriptor.port),
    previousKey
  })
  if (ready) return descriptor
  throw new Error(
    `${serviceLabel} was registered but did not answer within ${readyTimeoutMs / 1_000}s.\nCheck: ${statusCommand}\nLog: ${serviceErrorLogPath(descriptor.home)}`
  )
}

export interface InstallOptions {
  readonly program: ReadonlyArray<string>
  readonly port?: number
  readonly verbose?: boolean
}

/** Idempotent: reinstalling rewrites the unit and restarts the service, which
 *  is also how you pick up upgraded sources.
 *
 * Returns once the gateway actually answers, not once the service manager
 * accepts the unit: `systemctl restart` returns as soon as the process is
 * spawned, and a client that ran immediately afterwards used to be told there
 * was no gateway. */
export const installService = async (options: InstallOptions): Promise<ServiceDescriptor> => {
  const home = integrationsHome()
  const verbose = options.verbose ?? false
  await mkdir(path.join(home, "logs"), { recursive: true })
  const descriptor: ServiceDescriptor = {
    program: options.program,
    home,
    port: options.port ?? defaultGatewayPort
  }
  const previousKey = await recordedKey(home)
  if (process.platform === "linux") {
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
    // Without lingering the service stops at logout, which defeats the point
    // for a machine an agent reaches over SSH. Best effort: it needs polkit.
    await command("loginctl", ["enable-linger", userInfo().username], verbose).catch(() => undefined)
    return await installedAndReady(descriptor, previousKey, `systemctl --user status ${serviceLabel}`)
  }
  if (process.platform === "darwin") {
    const agents = path.join(homedir(), "Library", "LaunchAgents")
    const plist = path.join(agents, `${serviceLabel}.plist`)
    await mkdir(agents, { recursive: true })
    await writeFile(plist, launchdPlist(descriptor), { mode: 0o600 })
    await command("launchctl", ["bootout", `${launchdTarget()}/${serviceLabel}`], verbose)
      .catch(() => undefined)
    await command("launchctl", ["bootstrap", launchdTarget(), plist], verbose)
    return await installedAndReady(
      descriptor,
      previousKey,
      `launchctl print ${launchdTarget()}/${serviceLabel}`
    )
  }
  throw unsupportedPlatform("install")
}

/** Stops a registered unit without deregistering it, so the port is free for
 *  whatever starts next and the service manager will not restart it underneath.
 *  Not an error when no unit is registered or it was already stopped: the
 *  postcondition is "this unit is not running". */
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

/** Stops and deregisters the service. The home directory is left alone: it
 *  holds the connections and credentials, and removing a service definition is
 *  not consent to delete those. */
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

/** The program to re-execute for a service unit or a detached start. A compiled
 * binary re-executes itself; run from source `process.execPath` is bun, so the
 * entry point has to travel with it. `Bun.main` lives in the virtual filesystem
 * only in the compiled case, which is what distinguishes the two. */
export const serviceProgram = (): ReadonlyArray<string> =>
  Bun.main.startsWith("/$bunfs/") || Bun.main.startsWith("B:\\~BUN\\")
    ? [process.execPath]
    : [process.execPath, Bun.main]

/** A bind address is not always a reachable address. */
const probeBase = (host: string, port: number): string =>
  `http://${host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host}:${port}`

const responds = async (base: string): Promise<boolean> => {
  const response = await fetch(base, { signal: AbortSignal.timeout(1_000) }).catch(() => undefined)
  return response !== undefined
}

/** Listening is not the same as ready: the gateway mints the local key and
 * writes `gateway.json` after the socket opens, and a client that reads the
 * file in between gets the previous run's key.
 *
 * `previousKey` is what the start we are waiting on has to replace. Every start
 * mints a fresh key, so requiring a different one distinguishes *our* gateway
 * from whatever was answering on that port before — a restart that cannot bind
 * fails here instead of being reported as ready. */
const isReady = async (
  home: string,
  base: string,
  previousKey: string | undefined
): Promise<boolean> => {
  const config = await readGatewayConfig(home)
  if (config === undefined || config.apiKey === previousKey) return false
  const response = await fetch(`${base}/v1/integrations`, {
    headers: { authorization: `Bearer ${config.apiKey}` },
    signal: AbortSignal.timeout(1_000)
  }).catch(() => undefined)
  return response?.status === 200
}

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
  /** Lets the detached case fail fast when the child is already gone rather
   *  than waiting out the timeout. */
  readonly exitCode?: () => number | undefined
}

/** Polls until the gateway answers an authenticated request with a key it minted
 *  on this start. */
const waitUntilReady = async (options: WaitOptions): Promise<boolean> => {
  for (let waited = 0; waited < readyTimeoutMs; waited += readyIntervalMs) {
    if (options.exitCode?.() !== undefined) return false
    if (await isReady(options.home, options.base, options.previousKey)) return true
    await Bun.sleep(readyIntervalMs)
  }
  return false
}

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

/** `ii serve --detach` — a background gateway without knowing about
 * `&`. Its lifetime is a plain child process, the same as `&`: it goes away on
 * logout and does not come back after a reboot. `ii install` is the
 * option for that. */
export const startDetachedGateway = async (options: DetachOptions): Promise<DetachedGateway> => {
  const home = integrationsHome()
  const base = probeBase(options.host, options.port)
  if (await responds(base)) {
    throw new Error(
      `Something is already listening at ${base}. Stop it, or pass a different --port.`
    )
  }
  const previousKey = await recordedKey(home)
  await mkdir(path.join(home, "logs"), { recursive: true })
  const logPath = serviceLogPath(home)
  const errorPath = serviceErrorLogPath(home)
  const stdout = openSync(logPath, "a")
  const stderr = openSync(errorPath, "a")
  const child = Bun.spawn(
    [...options.program, "serve", "--port", String(options.port), "--host", options.host],
    { cwd: home, stdin: "ignore", stdout, stderr }
  )
  // The child holds its own copies; the parent is about to exit anyway.
  closeSync(stdout)
  closeSync(stderr)
  // Detached means the parent must not wait on it, and must not be kept alive
  // by it either.
  child.unref()
  let exitCode: number | undefined
  void child.exited.then((code) => {
    exitCode = code
  })
  if (await waitUntilReady({ home, base, previousKey, exitCode: () => exitCode })) {
    return { pid: child.pid, url: base, logPath }
  }
  if (exitCode !== undefined) {
    const tail = await logTail(errorPath)
    throw new Error(
      `The gateway exited immediately (code ${exitCode}).${tail.length === 0 ? "" : `\n${tail}`}`
    )
  }
  throw new Error(
    `The gateway did not become ready within ${readyTimeoutMs / 1_000}s. It is still running as pid ${child.pid}; see ${logPath}`
  )
}

export interface StoppedGateway {
  readonly pid: number
  readonly url: string
  /** SIGTERM was ignored and the process had to be killed. Worth reporting: a
   *  gateway that will not shut down cleanly may have left a connection open. */
  readonly forced: boolean
}

const stopTimeoutMs = 10_000

const isAlive = (pid: number): boolean => {
  try {
    // Signal 0 asks the kernel whether the pid exists without delivering
    // anything.
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

/** Best effort, and read only to refuse a pid that is demonstrably not a
 *  gateway: an unreadable command line is not evidence either way. */
const processCommand = async (pid: number): Promise<string | undefined> => {
  if (process.platform === "linux") {
    const raw = await Bun.file(`/proc/${pid}/cmdline`).text().catch(() => undefined)
    return raw === undefined ? undefined : raw.replaceAll("\0", " ").trim()
  }
  return (await capture("ps", ["-o", "command=", "-p", String(pid)]))?.trim()
}

/** For a gateway old enough not to have recorded its own pid. `lsof` covers
 *  both Linux and macOS; `ss` is the fallback for a Linux box without it. */
const listeningPid = async (port: number): Promise<number | undefined> => {
  const fromLsof = await capture("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"])
  const firstLine = fromLsof?.trim().split("\n")[0]?.trim()
  if (firstLine !== undefined && /^\d+$/.test(firstLine)) return Number(firstLine)
  const fromSs = await capture("ss", ["-tlnpH", `sport = :${port}`])
  const matched = fromSs?.match(/pid=(\d+)/)?.[1]
  return matched === undefined ? undefined : Number(matched)
}

const waitUntilStopped = async (base: string): Promise<boolean> => {
  for (let waited = 0; waited < stopTimeoutMs; waited += readyIntervalMs) {
    if (!await responds(base)) return true
    await Bun.sleep(readyIntervalMs)
  }
  return false
}

/** Stops the gateway the config file points at, so a restart can pick up
 *  changed sources. Returns `undefined` when nothing was listening, which is
 *  success for a caller that only wants a fresh gateway afterwards.
 *
 *  This signals a process it did not start, so it identifies the target three
 *  ways first — the recorded url answers, the recorded pid is alive, and that
 *  pid's command line is a `serve` — rather than trusting a config file that
 *  may describe a process that exited long ago and a pid the kernel has since
 *  reused. A service-managed gateway is not stopped this way: restarting the
 *  unit is `installService`, and killing its process would leave the unit
 *  looking inactive while an unmanaged gateway held the port. */
export const stopGateway = async (): Promise<StoppedGateway | undefined> => {
  const home = integrationsHome()
  const config = await readGatewayConfig(home)
  const port = config?.port ?? defaultGatewayPort
  const base = config?.url ?? probeBase("127.0.0.1", port)
  if (!await responds(base)) return undefined

  const recorded = config?.pid
  const pid = recorded !== undefined && isAlive(recorded) ? recorded : await listeningPid(port)
  if (pid === undefined) {
    throw new Error(
      `A gateway is answering at ${base}, but nothing on this machine could say which process it is. Stop it where you started it, then run this again.`
    )
  }
  const command = await processCommand(pid)
  if (command !== undefined && !command.includes("serve")) {
    throw new Error(
      `Refusing to stop pid ${pid}: its command line is not a gateway (${command}).`
    )
  }

  try {
    process.kill(pid, "SIGTERM")
  } catch (cause) {
    throw new Error(
      `Could not signal pid ${pid}: ${cause instanceof Error ? cause.message : String(cause)}`
    )
  }
  if (await waitUntilStopped(base)) return { pid, url: base, forced: false }

  if (isAlive(pid)) process.kill(pid, "SIGKILL")
  if (await waitUntilStopped(base)) return { pid, url: base, forced: true }
  throw new Error(
    `Pid ${pid} was signalled but ${base} is still answering after ${stopTimeoutMs / 1_000}s.`
  )
}
