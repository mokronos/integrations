import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const repoRoot = path.resolve(import.meta.dir, "../../../..")
const cliPath = path.join(repoRoot, "apps", "integrations", "cli", "src", "main.ts")
const decoder = new TextDecoder()
// A throwaway home, so spawning the CLI can never read the real ~/.wf.
const testHome = mkdtempSync(path.join(tmpdir(), "integrations-help-"))

const runCli = (args: ReadonlyArray<string>) => {
  const subprocess = Bun.spawnSync({
    cmd: [process.execPath, "run", cliPath, ...args],
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, INTEGRATIONS_HOME: testHome, NO_COLOR: "1" }
  })
  return {
    exitCode: subprocess.exitCode,
    stdout: decoder.decode(subprocess.stdout),
    stderr: decoder.decode(subprocess.stderr)
  }
}

describe("integrations CLI help", () => {
  test("lists the whole surface from the top level", () => {
    const result = runCli(["--help"])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("SUBCOMMANDS")
    for (const command of [
      "discover",
      "search",
      "list",
      "tools",
      "schema",
      "connect",
      "connections",
      "disconnect",
      "invoke",
      "execute",
      "validate",
      "grant",
      "approve",
      "audit",
      "serve"
    ]) {
      expect(`${command} listed: ${result.stdout.includes(command)}`)
        .toBe(`${command} listed: true`)
    }
  })

  test("every listing command offers --verbose", () => {
    // Progressive output is on by default and --verbose opts out of it. This
    // was reverted out of the old `wf i` tree by 16a656b; it is a requirement
    // of this CLI rather than something to rediscover later.
    for (const command of ["search", "list", "tools", "connections", "audit", "approvals"]) {
      const help = runCli([command, "--help"])
      expect(`${command}: ${help.exitCode}`).toBe(`${command}: 0`)
      expect(`${command} has --verbose: ${help.stdout.includes("--verbose")}`)
        .toBe(`${command} has --verbose: true`)
    }
  }, 20_000)

  test("shows arguments and flags for a specific command", () => {
    const help = runCli(["search", "--help"])

    expect(help.exitCode).toBe(0)
    expect(help.stdout).toContain("query string")
    expect(help.stdout).toContain("--text")
    expect(help.stdout).toContain("--verbose")
    expect(help.stdout).toContain("--kind")
  })

  test("reports a missing gateway instead of failing obscurely", () => {
    const result = runCli(["list"])

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("No gateway found")
  })

  test("rejects an unknown command", () => {
    const result = runCli(["missing"])
    expect(result.exitCode).not.toBe(0)
  })
})
