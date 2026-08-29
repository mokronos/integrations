import { access, realpath } from "node:fs/promises"
import { spawn, spawnSync } from "node:child_process"
import { dirname, basename, delimiter, isAbsolute, posix, relative, sep } from "node:path"
import { fileURLToPath } from "node:url"
import {
  ReadonlyProvider,
  RealFSProvider,
  VM
} from "@earendil-works/gondolin"
import type {
  ExtensionAPI,
  ExtensionContext
} from "@earendil-works/pi-coding-agent"
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  DEFAULT_MAX_BYTES,
  formatSize,
  truncateHead,
  truncateLine
} from "@earendil-works/pi-coding-agent"
import type {
  BashOperations,
  EditOperations,
  FindOperations,
  GrepToolDetails,
  GrepToolInput,
  LsOperations,
  ReadOperations,
  WriteOperations
} from "@earendil-works/pi-coding-agent"
import {
  decodeApiKey,
  decodeGatewayUrl,
  startGatewayBroker
} from "./broker.ts"
import type { GatewayBroker, OAuthPrompt } from "./broker.ts"

const GUEST_WORKSPACE = "/workspace"
const GUEST_INTEGRATIONS = "/opt/integrations"
const GUEST_BUN = "/opt/bun"
const GUEST_CLIENT_PACKAGE = `${GUEST_WORKSPACE}/node_modules/@mokronos/integrations-client`
const GUEST_CONTRACTS_PACKAGE = `${GUEST_WORKSPACE}/node_modules/@mokronos/contracts`
const GUEST_EFFECT_PACKAGE = `${GUEST_WORKSPACE}/node_modules/effect`
const GUEST_FAST_CHECK_PACKAGE = `${GUEST_WORKSPACE}/node_modules/fast-check`
const GUEST_MSGPACKR_PACKAGE = `${GUEST_WORKSPACE}/node_modules/msgpackr`
const GUEST_PURE_RAND_PACKAGE = `${GUEST_WORKSPACE}/node_modules/pure-rand`
const GATEWAY_HOST = "integrations.internal"
const GATEWAY_PORT = 4788
const DEFAULT_GREP_LIMIT = 100
const SOURCE_ROOT = fileURLToPath(new URL("../../..", import.meta.url))

type TextToolResult<TDetails> = {
  readonly content: Array<{ readonly type: "text"; readonly text: string }>
  readonly details: TDetails | undefined
}

const toPosix = (value: string): string => value.split(sep).join(posix.sep)

const isInside = (root: string, value: string): boolean => {
  const child = relative(root, value)
  return child === "" || (!child.startsWith("..") && !isAbsolute(child))
}

const toGuestPath = (hostRoot: string, input: string): string => {
  const value = input.startsWith("@") ? input.slice(1) : input
  if (isAbsolute(value)) {
    if (!isInside(hostRoot, value)) return posix.resolve("/", toPosix(value))
    const child = relative(hostRoot, value)
    return child === "" ? GUEST_WORKSPACE : posix.join(GUEST_WORKSPACE, toPosix(child))
  }
  return posix.resolve(GUEST_WORKSPACE, toPosix(value || "."))
}

const findExecutable = async (name: string): Promise<string> => {
  for (const directory of (process.env["PATH"] ?? "").split(delimiter)) {
    if (directory.length === 0) continue
    const candidate = `${directory}/${name}`
    try {
      await access(candidate)
      return await realpath(candidate)
    } catch {
      continue
    }
  }
  throw new Error(`${name} is required on the host`)
}

const findCompatibleQemu = async (): Promise<string> => {
  const executable = process.arch === "arm64"
    ? "qemu-system-aarch64"
    : process.arch === "x64"
      ? "qemu-system-x86_64"
      : undefined
  if (executable === undefined) {
    throw new Error(`Gondolin does not support the host architecture ${process.arch}`)
  }

  const qemuPath = await findExecutable(executable)
  const probe = spawnSync(qemuPath, ["-netdev", "help"], { encoding: "utf8" })
  if (probe.error !== undefined) throw probe.error
  if (probe.status !== 0) {
    throw new Error(`Could not inspect ${qemuPath}: ${probe.stderr.trim()}`)
  }
  if (!probe.stdout.split(/\r?\n/).includes("stream")) {
    throw new Error(
      `${qemuPath} lacks Gondolin's required QEMU stream network backend. ` +
      "Install QEMU 7.2 or newer and ensure it appears first in PATH. " +
      "Ubuntu 22.04's QEMU 6.2 is too old; Ubuntu 24.04 includes a compatible version."
    )
  }
  return qemuPath
}

const hostOpen = (url: URL): void => {
  const command = process.platform === "darwin"
    ? ["open", url.href]
    : process.platform === "win32"
      ? ["cmd", "/c", "start", "", url.href]
      : ["xdg-open", url.href]
  const child = spawn(command[0] ?? "", command.slice(1), {
    stdio: "ignore",
    detached: true
  })
  child.unref()
}

const isSafeAuthorizationUrl = (url: URL): boolean =>
  url.protocol === "https:" ||
  (url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost"))

const createReadOperations = (vm: VM, hostRoot: string): ReadOperations => ({
  readFile: async (path) => vm.fs.readFile(toGuestPath(hostRoot, path)),
  access: async (path) => {
    await vm.fs.access(toGuestPath(hostRoot, path))
  },
  detectImageMimeType: async (path) => {
    const extension = posix.extname(toGuestPath(hostRoot, path)).toLowerCase()
    if (extension === ".png") return "image/png"
    if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg"
    if (extension === ".gif") return "image/gif"
    if (extension === ".webp") return "image/webp"
    return null
  }
})

const createWriteOperations = (vm: VM, hostRoot: string): WriteOperations => ({
  writeFile: async (path, content) => {
    await vm.fs.writeFile(toGuestPath(hostRoot, path), content, { encoding: "utf8" })
  },
  mkdir: async (path) => {
    await vm.fs.mkdir(toGuestPath(hostRoot, path), { recursive: true })
  }
})

const createEditOperations = (vm: VM, hostRoot: string): EditOperations => {
  const read = createReadOperations(vm, hostRoot)
  const write = createWriteOperations(vm, hostRoot)
  return {
    readFile: read.readFile,
    access: read.access,
    writeFile: write.writeFile
  }
}

const createLsOperations = (vm: VM, hostRoot: string): LsOperations => ({
  exists: async (path) => {
    try {
      await vm.fs.access(toGuestPath(hostRoot, path))
      return true
    } catch {
      return false
    }
  },
  stat: async (path) => vm.fs.stat(toGuestPath(hostRoot, path)),
  readdir: async (path) => vm.fs.listDir(toGuestPath(hostRoot, path))
})

const walkGuestFiles = async (
  vm: VM,
  root: string,
  visit: (guestPath: string, relativePath: string) => Promise<boolean>,
  signal?: AbortSignal
): Promise<boolean> => {
  if (signal?.aborted) throw new Error("Operation aborted")
  const signalOptions = signal === undefined ? {} : { signal }
  const rootStat = await vm.fs.stat(root, signalOptions)
  if (!rootStat.isDirectory()) return visit(root, posix.basename(root))

  const walkDirectory = async (directory: string, relativeDirectory: string): Promise<boolean> => {
    if (signal?.aborted) throw new Error("Operation aborted")
    for (const entry of await vm.fs.listDir(directory, signalOptions)) {
      if (entry === ".git" || entry === "node_modules") continue
      const guestPath = posix.join(directory, entry)
      const relativePath = relativeDirectory === ""
        ? entry
        : posix.join(relativeDirectory, entry)
      let stat: Awaited<ReturnType<VM["fs"]["stat"]>>
      try {
        stat = await vm.fs.stat(guestPath, signalOptions)
      } catch {
        continue
      }
      if (stat.isDirectory()) {
        if (!await walkDirectory(guestPath, relativePath)) return false
      } else if (!await visit(guestPath, relativePath)) {
        return false
      }
    }
    return true
  }

  return walkDirectory(root, "")
}

const matchesGlob = (relativePath: string, pattern: string): boolean => {
  const normalized = toPosix(pattern)
  return normalized.includes("/")
    ? posix.matchesGlob(relativePath, normalized) ||
      posix.matchesGlob(relativePath, `**/${normalized}`)
    : posix.matchesGlob(posix.basename(relativePath), normalized)
}

const createFindOperations = (vm: VM, hostRoot: string): FindOperations => ({
  exists: async (path) => {
    try {
      await vm.fs.access(toGuestPath(hostRoot, path))
      return true
    } catch {
      return false
    }
  },
  glob: async (pattern, cwd, options) => {
    const results: Array<string> = []
    await walkGuestFiles(vm, toGuestPath(hostRoot, cwd), async (guestPath, relativePath) => {
      if (results.length >= options.limit) return false
      if (matchesGlob(relativePath, pattern)) results.push(guestPath)
      return results.length < options.limit
    })
    return results
  }
})

const lineMatcher = (
  pattern: string,
  literal: boolean | undefined,
  ignoreCase: boolean | undefined
): ((line: string) => boolean) => {
  if (literal === true) {
    const needle = ignoreCase === true ? pattern.toLowerCase() : pattern
    return (line) => (ignoreCase === true ? line.toLowerCase() : line).includes(needle)
  }
  const expression = new RegExp(pattern, ignoreCase === true ? "i" : undefined)
  return (line) => expression.test(line)
}

const appendMatch = (options: {
  readonly output: Array<string>
  readonly lines: ReadonlyArray<string>
  readonly relativePath: string
  readonly lineIndex: number
  readonly contextLines: number
}): boolean => {
  let truncated = false
  const start = Math.max(0, options.lineIndex - options.contextLines)
  const end = Math.min(options.lines.length - 1, options.lineIndex + options.contextLines)
  for (let index = start; index <= end; index++) {
    const line = truncateLine((options.lines[index] ?? "").replace(/\r/g, ""))
    truncated ||= line.wasTruncated
    const separator = index === options.lineIndex ? ":" : "-"
    options.output.push(`${options.relativePath}${separator}${index + 1}${separator} ${line.text}`)
  }
  return truncated
}

const executeGrep = async (
  vm: VM,
  hostRoot: string,
  input: GrepToolInput,
  signal?: AbortSignal
): Promise<TextToolResult<GrepToolDetails>> => {
  const root = toGuestPath(hostRoot, input.path ?? ".")
  const signalOptions = signal === undefined ? {} : { signal }
  const rootIsDirectory = (await vm.fs.stat(root, signalOptions)).isDirectory()
  const matches = lineMatcher(input.pattern, input.literal, input.ignoreCase)
  const contextLines = Math.max(0, input.context ?? 0)
  const limit = Math.max(1, input.limit ?? DEFAULT_GREP_LIMIT)
  const output: Array<string> = []
  let count = 0
  let linesTruncated = false

  await walkGuestFiles(vm, root, async (guestPath, relativePath) => {
    if (count >= limit) return false
    if (input.glob !== undefined && !matchesGlob(relativePath, input.glob)) return true
    let content: string
    try {
      content = await vm.fs.readFile(guestPath, { encoding: "utf8", ...signalOptions })
    } catch {
      return true
    }
    const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")
    const displayPath = rootIsDirectory ? relativePath : posix.basename(guestPath)
    for (let index = 0; index < lines.length; index++) {
      if (signal?.aborted) throw new Error("Operation aborted")
      if (!matches(lines[index] ?? "")) continue
      count++
      linesTruncated ||= appendMatch({
        output,
        lines,
        relativePath: displayPath,
        lineIndex: index,
        contextLines
      })
      if (count >= limit) return false
    }
    return true
  }, signal)

  if (count === 0) {
    return { content: [{ type: "text", text: "No matches found" }], details: undefined }
  }
  const truncation = truncateHead(output.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER })
  const notices: Array<string> = []
  const details: GrepToolDetails = {}
  if (count >= limit) {
    details.matchLimitReached = limit
    notices.push(`${limit} matches limit reached`)
  }
  if (linesTruncated) {
    details.linesTruncated = true
    notices.push("long lines truncated")
  }
  if (truncation.truncated) {
    details.truncation = truncation
    notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`)
  }
  const suffix = notices.length === 0 ? "" : `\n\n[${notices.join(". ")}]`
  return {
    content: [{ type: "text", text: `${truncation.content}${suffix}` }],
    details
  }
}

const guestEnvironment = (bunName: string) => ({
  HOME: "/home/sandbox",
  PATH: `/usr/local/bin:${GUEST_BUN}:/usr/bin:/bin`,
  INTEGRATIONS_URL: `http://${GATEWAY_HOST}:${GATEWAY_PORT}`,
  INTEGRATIONS_API_KEY: "proxied-by-host",
  LANG: "C.UTF-8",
  BUN_INSTALL: GUEST_BUN,
  INTEGRATIONS_BUN: `${GUEST_BUN}/${bunName}`
})

const createBashOperations = (
  vm: VM,
  hostRoot: string,
  environment: Readonly<Record<string, string>>,
  shellPath: string
): BashOperations => ({
  exec: async (command, cwd, { onData, signal, timeout }) => {
    if (signal?.aborted) throw new Error("aborted")
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal?.addEventListener("abort", abort, { once: true })
    let timedOut = false
    const timer = timeout === undefined || timeout <= 0
      ? undefined
      : setTimeout(() => {
        timedOut = true
        controller.abort()
      }, timeout * 1000)
    try {
      const process = vm.exec([shellPath, "-lc", command], {
        cwd: toGuestPath(hostRoot, cwd),
        env: environment,
        signal: controller.signal,
        stdout: "pipe",
        stderr: "pipe"
      })
      for await (const chunk of process.output()) onData(chunk.data)
      return { exitCode: (await process).exitCode }
    } catch (error) {
      if (signal?.aborted) throw new Error("aborted")
      if (timedOut) throw new Error(`timeout:${timeout}`)
      throw error
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
    }
  }
})

const installGuestCommands = async (vm: VM, bunPath: string): Promise<string> => {
  const script = [
    "set -eu",
    "mkdir -p /home/sandbox /usr/local/bin",
    `printf '%s\\n' '#!/bin/sh' 'exec ${bunPath} run ${GUEST_INTEGRATIONS}/apps/cli/src/agent.ts "$@"' > /usr/local/bin/i`,
    "printf '%s\\n' '#!/bin/sh' 'exit 0' > /usr/local/bin/xdg-open",
    "chmod +x /usr/local/bin/i /usr/local/bin/xdg-open",
    "command -v bash || true"
  ].join("\n")
  const result = await vm.exec(["/bin/sh", "-lc", script])
  if (!result.ok) throw new Error(`Failed to install guest commands: ${result.stderr}`)
  return result.stdout.trim() || "/bin/sh"
}

export default function sandboxLocal(pi: ExtensionAPI): void {
  const hostRoot = process.cwd()
  const localRead = createReadTool(hostRoot)
  const localWrite = createWriteTool(hostRoot)
  const localEdit = createEditTool(hostRoot)
  const localBash = createBashTool(hostRoot)
  const localGrep = createGrepTool(hostRoot)
  const localFind = createFindTool(hostRoot)
  const localLs = createLsTool(hostRoot)
  const promptedSessions = new Set<string>()
  let vm: VM | undefined
  let broker: GatewayBroker | undefined
  let starting: Promise<VM> | undefined
  let startupFailure: Error | undefined
  let shellPath = "/bin/sh"
  let environment: Readonly<Record<string, string>> = {}
  let promptQueue = Promise.resolve()

  const queueOAuthPrompt = (ctx: ExtensionContext, prompt: OAuthPrompt): void => {
    if (promptedSessions.has(prompt.sessionId)) return
    promptedSessions.add(prompt.sessionId)
    promptQueue = promptQueue.then(async () => {
      if (!isSafeAuthorizationUrl(prompt.authorizationUrl)) {
        ctx.ui.notify(
          `Refused OAuth URL with protocol ${prompt.authorizationUrl.protocol}`,
          "error"
        )
        return
      }
      const host = prompt.authorizationUrl.host
      if (!ctx.hasUI) {
        ctx.ui.notify(`OAuth waiting for a human: ${prompt.authorizationUrl.href}`, "warning")
        return
      }
      const confirmed = await ctx.ui.confirm(
        `Connect ${prompt.integration}?`,
        `Connection: ${prompt.connection}\nAuthorization host: ${host}\n\nOpen this page in your host browser?`
      )
      if (confirmed) hostOpen(prompt.authorizationUrl)
    }).catch((error) => {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error")
    })
  }

  const start = async (ctx: ExtensionContext): Promise<VM> => {
    const gatewayUrl = process.env["INTEGRATIONS_URL"]
    const apiKey = process.env["INTEGRATIONS_API_KEY"]
    if (gatewayUrl === undefined || apiKey === undefined) {
      throw new Error("Set host INTEGRATIONS_URL and INTEGRATIONS_API_KEY before starting Pi")
    }
    const qemuPath = await findCompatibleQemu()
    const bunExecutable = await findExecutable("bun")
    const bunDirectory = dirname(bunExecutable)
    const bunName = basename(bunExecutable)
    const effectPackage = await realpath(`${SOURCE_ROOT}/node_modules/effect`)
    const effectDependencies = dirname(effectPackage)
    const fastCheckPackage = await realpath(`${effectDependencies}/fast-check`)
    const msgpackrPackage = await realpath(`${effectDependencies}/msgpackr`)
    const pureRandPackage = await realpath(`${dirname(fastCheckPackage)}/pure-rand`)
    const activeBroker = await startGatewayBroker({
      gatewayUrl: decodeGatewayUrl(gatewayUrl),
      apiKey: decodeApiKey(apiKey),
      onOAuthPrompt: (prompt) => queueOAuthPrompt(ctx, prompt)
    })
    broker = activeBroker
    environment = guestEnvironment(bunName)
    ctx.ui.setStatus("sandbox-local", "Sandbox: starting")
    try {
      const created = await VM.create({
        sandbox: { qemuPath },
        sessionLabel: `integrations ${basename(hostRoot)}`,
        memory: "1G",
        cpus: 2,
        allowWebSockets: false,
        env: environment,
        dns: {
          mode: "synthetic",
          syntheticHostMapping: "per-host"
        },
        tcp: {
          hosts: {
            [`${GATEWAY_HOST}:${GATEWAY_PORT}`]: `127.0.0.1:${activeBroker.port}`
          }
        },
        vfs: {
          mounts: {
            [GUEST_WORKSPACE]: new RealFSProvider(hostRoot),
            [GUEST_INTEGRATIONS]: new ReadonlyProvider(new RealFSProvider(SOURCE_ROOT)),
            [GUEST_BUN]: new ReadonlyProvider(new RealFSProvider(bunDirectory)),
            [GUEST_CLIENT_PACKAGE]: new ReadonlyProvider(
              new RealFSProvider(`${SOURCE_ROOT}/apps/ts`)
            ),
            [GUEST_CONTRACTS_PACKAGE]: new ReadonlyProvider(
              new RealFSProvider(`${SOURCE_ROOT}/packages/contracts`)
            ),
            [GUEST_EFFECT_PACKAGE]: new ReadonlyProvider(
              new RealFSProvider(effectPackage)
            ),
            [GUEST_FAST_CHECK_PACKAGE]: new ReadonlyProvider(
              new RealFSProvider(fastCheckPackage)
            ),
            [GUEST_MSGPACKR_PACKAGE]: new ReadonlyProvider(
              new RealFSProvider(msgpackrPackage)
            ),
            [GUEST_PURE_RAND_PACKAGE]: new ReadonlyProvider(
              new RealFSProvider(pureRandPackage)
            )
          }
        }
      })
      const guestBun = `${GUEST_BUN}/${bunName}`
      shellPath = await installGuestCommands(created, guestBun)
      const clientProbe = await created.exec([
        guestBun,
        "-e",
        'import { createGatewayClient } from "@mokronos/integrations-client"; if (typeof createGatewayClient !== "function") process.exit(1)'
      ], { cwd: GUEST_WORKSPACE, env: environment })
      if (!clientProbe.ok) {
        await created.close()
        throw new Error(`Injected TypeScript client is unavailable: ${clientProbe.stderr}`)
      }
      const cliProbe = await created.exec(["/usr/local/bin/i", "--help"], {
        cwd: GUEST_WORKSPACE,
        env: environment
      })
      if (!cliProbe.ok) {
        await created.close()
        throw new Error(`Injected integrations CLI is unavailable: ${cliProbe.stderr}`)
      }
      vm = created
      ctx.ui.setStatus("sandbox-local", `Sandbox: ${created.id.slice(0, 8)}`)
      ctx.ui.notify(`Sandbox ready at ${GUEST_WORKSPACE}`, "info")
      return created
    } catch (error) {
      await activeBroker.close()
      broker = undefined
      ctx.ui.setStatus("sandbox-local", undefined)
      throw error
    }
  }

  const ensureVm = (ctx: ExtensionContext): Promise<VM> => {
    if (vm !== undefined) return Promise.resolve(vm)
    if (startupFailure !== undefined) return Promise.reject(startupFailure)
    if (starting === undefined) {
      starting = start(ctx)
        .catch((error) => {
          startupFailure = error instanceof Error ? error : new Error(String(error))
          throw startupFailure
        })
        .finally(() => {
          starting = undefined
        })
    }
    return starting
  }

  pi.on("project_trust", () => ({ trusted: "no" }))

  pi.on("session_start", async (_event, ctx) => {
    await ensureVm(ctx)
  })

  pi.on("session_shutdown", async (_event, ctx) => {
    const activeVm = vm
    const activeBroker = broker
    vm = undefined
    broker = undefined
    starting = undefined
    startupFailure = undefined
    await Promise.all([
      activeVm?.close(),
      activeBroker?.close()
    ])
    ctx.ui.setStatus("sandbox-local", undefined)
  })

  pi.registerTool({
    ...localRead,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await ensureVm(ctx)
      return createReadTool(GUEST_WORKSPACE, {
        operations: createReadOperations(activeVm, hostRoot)
      }).execute(id, params, signal, onUpdate)
    }
  })

  pi.registerTool({
    ...localWrite,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await ensureVm(ctx)
      return createWriteTool(GUEST_WORKSPACE, {
        operations: createWriteOperations(activeVm, hostRoot)
      }).execute(id, params, signal, onUpdate)
    }
  })

  pi.registerTool({
    ...localEdit,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await ensureVm(ctx)
      return createEditTool(GUEST_WORKSPACE, {
        operations: createEditOperations(activeVm, hostRoot)
      }).execute(id, params, signal, onUpdate)
    }
  })

  pi.registerTool({
    ...localBash,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await ensureVm(ctx)
      return createBashTool(GUEST_WORKSPACE, {
        operations: createBashOperations(activeVm, hostRoot, environment, shellPath)
      }).execute(id, params, signal, onUpdate)
    }
  })

  pi.registerTool({
    ...localLs,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await ensureVm(ctx)
      return createLsTool(GUEST_WORKSPACE, {
        operations: createLsOperations(activeVm, hostRoot)
      }).execute(id, params, signal, onUpdate)
    }
  })

  pi.registerTool({
    ...localFind,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await ensureVm(ctx)
      return createFindTool(GUEST_WORKSPACE, {
        operations: createFindOperations(activeVm, hostRoot)
      }).execute(id, params, signal, onUpdate)
    }
  })

  pi.registerTool({
    ...localGrep,
    async execute(_id, params, signal, _onUpdate, ctx) {
      return executeGrep(await ensureVm(ctx), hostRoot, params, signal)
    }
  })

  pi.on("user_bash", async (_event, ctx) => ({
    operations: createBashOperations(
      await ensureVm(ctx),
      hostRoot,
      environment,
      shellPath
    )
  }))

  pi.on("before_agent_start", async (event, ctx) => {
    await ensureVm(ctx)
    const hostLine = `Current working directory: ${hostRoot}`
    const guestLine = `Current working directory: ${GUEST_WORKSPACE} (isolated Gondolin VM)`
    return {
      systemPrompt: event.systemPrompt.includes(hostLine)
        ? event.systemPrompt.replace(hostLine, guestLine)
        : `${event.systemPrompt}\n\n${guestLine}`
    }
  })
}
