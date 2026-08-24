import { chmod, lstat, mkdir, readlink, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { Schema } from "effect"

const Installable = Schema.Struct({
  name: Schema.Literals(["i", "ii"]),
  entry: Schema.String
})
type Installable = typeof Installable.Type

const InstallOptions = Schema.Struct({ directory: Schema.String })
export type InstallOptions = typeof InstallOptions.Type

const packageDirectory = import.meta.dir
/** Two levels up from `apps/cli`. Derived rather than searched, so moving the
 *  package is a compile-and-test failure rather than a shim that points at the
 *  wrong tree. */
export const repositoryDirectory = path.resolve(packageDirectory, "../..")

const installables: ReadonlyArray<Installable> = [
  { name: "i", entry: path.join(packageDirectory, "src", "agent.ts") },
  { name: "ii", entry: path.join(packageDirectory, "src", "main.ts") }
]

const entryPoint = (name: Installable["name"]): string => {
  const installable = installables.find((candidate) => candidate.name === name)
  if (installable === undefined) throw new Error(`No entry point for ${name}`)
  return installable.entry
}

/** The program to run this working tree's `ii`: the checkout's own Bun plus the
 * operator entry point. `serviceProgram()` cannot answer this for a caller that
 * is not itself `ii` — it reports whatever script Bun is running. */
export const operatorProgram = (): ReadonlyArray<string> => [process.execPath, entryPoint("ii")]

export const usage = `Install this working tree's i and ii binaries onto PATH.

Usage:
  bun run install:local [--dir <directory>]

The generated shims run the TypeScript sources through this checkout's Bun
executable. Source changes therefore take effect without reinstalling. The
default directory is the first existing directory of ~/.bun/bin or
~/.local/bin, falling back to ~/.local/bin.
`

const candidateDirectories = (): ReadonlyArray<string> => [
  path.join(homedir(), ".bun", "bin"),
  path.join(homedir(), ".local", "bin")
]

const directoryExists = async (location: string): Promise<boolean> => {
  try {
    return (await lstat(location)).isDirectory()
  } catch {
    return false
  }
}

const defaultDirectory = async (): Promise<string> => {
  for (const candidate of candidateDirectories()) {
    if (await directoryExists(candidate)) return candidate
  }
  return path.join(homedir(), ".local", "bin")
}

export const parseInstallOptions = async (
  argv: ReadonlyArray<string>
): Promise<InstallOptions> => {
  let directory: string | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument !== "--dir") throw new Error(`Unknown option: ${argument}\n\n${usage}`)
    const value = argv[index + 1]
    if (value === undefined) throw new Error("--dir requires a directory")
    directory = path.resolve(value)
    index += 1
  }
  return Schema.decodeUnknownSync(InstallOptions)({
    directory: directory ?? await defaultDirectory()
  })
}

const managedShim = (contents: string): boolean =>
  contents.includes("Local development install of") &&
  contents.includes("written by: bun run install:local")

/** Replaces only symlinks and shims written by this installer. An unrelated
 * executable with the same name requires an explicit human decision. */
const clearTarget = async (target: string): Promise<void> => {
  let existing: Awaited<ReturnType<typeof lstat>>
  try {
    existing = await lstat(target)
  } catch {
    return
  }
  if (existing.isSymbolicLink()) {
    const destination = path.resolve(path.dirname(target), await readlink(target))
    if (installables.some((installable) => installable.entry === destination)) {
      await rm(target)
      return
    }
    throw new Error(`Refusing to replace ${target}: symlink is not a local integrations install`)
  }
  if (!existing.isFile()) {
    throw new Error(`Refusing to replace ${target}: not a file or symlink`)
  }
  if (!managedShim(await Bun.file(target).text())) {
    throw new Error(`Refusing to replace ${target}: not a local integrations install`)
  }
  await rm(target)
}

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`

const shim = (installable: Installable): string => `#!/usr/bin/env sh
# Local development install of ${installable.name}, written by: bun run install:local
# Runs the working tree at ${repositoryDirectory} directly. Re-run after moving it.
exec ${shellQuote(process.execPath)} ${shellQuote(installable.entry)} "$@"
`

const shellPathEntries = (): ReadonlyArray<string> => {
  const injected = `node_modules${path.sep}.bin`
  return (process.env["PATH"] ?? "").split(path.delimiter)
    .filter((entry) => entry.length > 0 && !entry.endsWith(injected))
}

const resolvesToTarget = async (candidate: string, target: string): Promise<boolean> =>
  candidate === target || await readlink(candidate)
    .then((value) => path.resolve(path.dirname(candidate), value) === target)
    .catch(() => false)

const shadowingWarning = async (target: string): Promise<string | undefined> => {
  const name = path.basename(target)
  for (const entry of shellPathEntries()) {
    const candidate = path.join(entry, name)
    if (!await Bun.file(candidate).exists()) continue
    if (await resolvesToTarget(candidate, target)) return undefined
    return `PATH resolves ${name} to ${candidate}, which shadows this install.`
  }
  return `${path.dirname(target)} is not on PATH; add it to use ${name}.`
}

export const installLocal = async (options: InstallOptions): Promise<void> => {
  const decoded = Schema.decodeUnknownSync(InstallOptions)(options)
  await mkdir(decoded.directory, { recursive: true })
  for (const installable of installables) {
    if (!await Bun.file(installable.entry).exists()) {
      throw new Error(`CLI entry point is missing: ${installable.entry}`)
    }
    const target = path.join(decoded.directory, installable.name)
    await clearTarget(target)
    await writeFile(target, shim(installable), { mode: 0o755 })
    await chmod(target, 0o755)
    console.log(`installed ${installable.name} -> ${target}`)
    const warning = await shadowingWarning(target)
    if (warning !== undefined) console.warn(`warning: ${warning}`)
  }
  console.log("source changes take effect without reinstalling")
}

const main = async (): Promise<void> => {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(usage)
    return
  }
  await installLocal(await parseInstallOptions(process.argv.slice(2)))
}

if (import.meta.main) {
  try {
    await main()
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : "install:local failed"}`)
    process.exitCode = 1
  }
}
