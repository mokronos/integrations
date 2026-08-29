import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Schema } from "effect"

const repoRoot = path.resolve(import.meta.dir, "../../..")
const directories: Array<string> = []

const SmokeManifest = Schema.Struct({
  name: Schema.String,
  private: Schema.Boolean,
  dependencies: Schema.Record(Schema.String, Schema.String),
  overrides: Schema.Record(Schema.String, Schema.String)
})
const encodeSmokeManifest = Schema.encodeSync(Schema.fromJsonString(SmokeManifest))

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

const run = async (command: ReadonlyArray<string>, cwd: string) => {
  const subprocess = Bun.spawn({
    cmd: [...command],
    cwd,
    env: { ...process.env, NO_COLOR: "1" },
    stdout: "pipe",
    stderr: "pipe"
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text()
  ])
  return { exitCode, stdout, stderr }
}

const pack = async (packageDirectory: string, destination: string): Promise<string> => {
  const packed = await run([
    process.execPath,
    "pm",
    "pack",
    "--ignore-scripts",
    "--destination",
    destination,
    "--quiet"
  ], packageDirectory)
  expect(packed.exitCode, packed.stderr).toBe(0)
  const tarball = packed.stdout.trim().split("\n").at(-1)
  if (tarball === undefined || tarball.length === 0) {
    throw new Error(`bun pm pack did not report a tarball for ${packageDirectory}`)
  }
  return path.isAbsolute(tarball) ? tarball : path.join(packageDirectory, tarball)
}

describe("published CLI package", () => {
  test("installs exactly the i and ii binaries from its packed tarball", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "integrations-package-"))
    directories.push(directory)
    const tarballs = path.join(directory, "tarballs")
    const project = path.join(directory, "consumer")
    await mkdir(tarballs)
    await mkdir(project)

    const host = await pack(
      path.join(repoRoot, "packages", "integrations"),
      tarballs
    )
    const contracts = await pack(
      path.join(repoRoot, "packages", "contracts"),
      tarballs
    )
    const client = await pack(path.join(repoRoot, "apps", "ts"), tarballs)
    const observability = await pack(path.join(repoRoot, "packages", "observability"), tarballs)
    const coreIntegrations = await pack(
      path.join(repoRoot, "packages", "core", "integrations"),
      tarballs
    )
    const gatewayCore = await pack(path.join(repoRoot, "packages", "core", "gateway"), tarballs)
    const gatewayApi = await pack(path.join(repoRoot, "packages", "core", "api"), tarballs)
    const local = await pack(path.join(repoRoot, "apps", "local"), tarballs)
    const cli = await pack(path.join(repoRoot, "apps", "cli"), tarballs)

    const localPackages = {
      "@mokronos/gateway-core": `file:${gatewayCore}`,
      "@mokronos/gateway-api": `file:${gatewayApi}`,
      "@mokronos/integrations-local": `file:${local}`,
      "@mokronos/integrations-client": `file:${client}`,
      "@mokronos/integrations": `file:${host}`,
      "@mokronos/core-integrations": `file:${coreIntegrations}`,
      "@mokronos/observability": `file:${observability}`,
      "@mokronos/contracts": `file:${contracts}`
    }
    await Bun.write(path.join(project, "package.json"), `${encodeSmokeManifest({
      name: "integrations-package-smoke",
      private: true,
      dependencies: {
        "@mokronos/integrations-cli": `file:${cli}`,
        ...localPackages
      },
      overrides: localPackages
    })}\n`)

    const installed = await run([process.execPath, "install", "--ignore-scripts"], project)
    expect(installed.exitCode, installed.stderr).toBe(0)

    const bin = path.join(project, "node_modules", ".bin")
    const agent = await run([path.join(bin, "i"), "--help"], project)
    const operator = await run([path.join(bin, "ii"), "--help"], project)
    expect(agent.exitCode, agent.stderr).toBe(0)
    expect(agent.stdout).toContain("USAGE\n  i <subcommand>")
    expect(operator.exitCode, operator.stderr).toBe(0)
    expect(operator.stdout).toContain("USAGE\n  ii <subcommand>")
    expect(await Bun.file(path.join(bin, "integrations")).exists()).toBe(false)
  }, 120_000)
})
