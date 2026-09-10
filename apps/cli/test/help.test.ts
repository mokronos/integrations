import { describe, expect, test } from "@effect/vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const repoRoot = path.resolve(import.meta.dirname, "../../..")
const agentCliPath = path.join(repoRoot, "apps", "cli", "src", "agent.ts")
const operatorCliPath = path.join(repoRoot, "apps", "cli", "src", "main.ts")
const decoder = new TextDecoder()
const testHome = mkdtempSync(path.join(tmpdir(), "integrations-help-"))

const runCli = (cliPath: string, args: ReadonlyArray<string>) => {
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

const runAgent = (args: ReadonlyArray<string>) => runCli(agentCliPath, args)
const runOperator = (args: ReadonlyArray<string>) => runCli(operatorCliPath, args)
const hasCommand = (help: string, command: string): boolean => {
  const subcommands = help.split("SUBCOMMANDS\n")[1] ?? ""
  return subcommands.split("\n").some((line) => {
    const name = line.trim().split(/\s+/)[0]
    return name === command || name?.split(",")[0] === command
  })
}

describe("i and ii CLI help", () => {
  test("i lists only the delegated client surface", () => {
    const result = runAgent(["--help"])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("SUBCOMMANDS")
    for (const command of [
      "discover",
      "search",
      "integrations",
      "tools",
      "schema",
      "connect",
      "connections",
      "disconnect",
      "execute",
      "validate",
      "approval"
    ]) {
      expect(hasCommand(result.stdout, command)).toBe(true)
    }
    for (const command of [
      "clients",
      "client",
      "key",
      "keys",
      "grant",
      "grants",
      "policies",
      "policy",
      "clone-policy",
      "policy-tool",
      "assign-policy",
      "revoke",
      "codegen",
      "approvals",
      "approve",
      "deny",
      "audit",
      "drift",
      "maintenance",
      "login",
      "logout",
      "serve",
      "dashboard",
      "install",
      "uninstall"
    ]) {
      expect(hasCommand(result.stdout, command)).toBe(false)
    }
  }, 30_000)

  test("ii is a strict superset of i and includes operator, account, and service commands", () => {
    const agent = runAgent(["--help"])
    const operator = runOperator(["--help"])
    const agentCommands = agent.stdout
      .split("\n")
      .filter((line) => line.startsWith("  ") && !line.startsWith("  --"))
      .map((line) => line.trim().split(/\s+/)[0])
      .filter((command) => command !== undefined)

    for (const command of agentCommands) {
      expect(operator.stdout.includes(`  ${command}`)).toBe(true)
    }
    for (const command of [
      "clients", "client", "key", "keys", "access-profiles", "access-profile",
      "clone-access-profile", "access-profile-tool", "assign-access-profile",
      "approval-policies", "approval-policy", "clone-approval-policy",
      "approval-policy-tool", "assign-approval-policy", "revoke", "approvals",
      "approve", "deny", "audit", "drift", "maintenance", "login", "signup",
      "logout", "whoami", "account", "serve", "dashboard", "install", "uninstall"
    ]) {
      expect(hasCommand(operator.stdout, command)).toBe(true)
    }
  }, 30_000)

  test("every listing command windows with --limit and --offset", () => {
    for (
      const command of [
        "integrations", "tools", "connections", "clients", "access-profiles",
        "approval-policies", "audit", "approvals"
      ]
    ) {
      const help = runOperator([command, "--help"])
      expect(help.exitCode).toBe(0)
      expect(help.stdout).toContain("--limit")
      expect(help.stdout).toContain("--offset")
      expect(help.stdout).toContain("--verbose")
    }
  }, 30_000)

  test("reports a missing integrations service instead of failing obscurely", () => {
    const result = runAgent(["integrations"])

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("No integrations service found")
  })

})
