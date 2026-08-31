import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const repoRoot = path.resolve(import.meta.dir, "../../..")
const agentCliPath = path.join(repoRoot, "apps", "cli", "src", "agent.ts")
const operatorCliPath = path.join(repoRoot, "apps", "cli", "src", "main.ts")
const decoder = new TextDecoder()
// A throwaway home, so spawning the CLI can never read the real ~/.integrations.
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

  test("ii is a strict superset of i and includes operator, account, and host commands", () => {
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
      "clients", "client", "key", "keys", "policies", "policy", "clone-policy",
      "policy-tool", "assign-policy", "revoke", "approvals",
      "approve", "deny", "audit", "drift", "maintenance", "login", "signup",
      "logout", "whoami", "account", "serve", "dashboard", "install", "uninstall"
    ]) {
      expect(hasCommand(operator.stdout, command)).toBe(true)
    }
  }, 30_000)

  test("every listing command windows with --limit and --offset", () => {
    // Listings return everything by default. What they must never do is drop
    // rows silently — so the window is explicit, and it is the same window on
    // every listing rather than a different mechanism per command.
    for (
      const command of ["integrations", "tools", "connections", "clients", "policies", "audit", "approvals"]
    ) {
      const help = runOperator([command, "--help"])
      expect(help.exitCode).toBe(0)
      expect(help.stdout).toContain("--limit")
      expect(help.stdout).toContain("--offset")
      expect(help.stdout).toContain("--verbose")
    }
  }, 30_000)

  test("offers a detached start and a service install", () => {
    // Two ways to get a gateway that stays up: `&` without knowing about `&`,
    // and a real service that survives a reboot.
    const serve = runOperator(["serve", "--help"])
    expect(serve.exitCode).toBe(0)
    expect(serve.stdout).toContain("--detach")
    expect(serve.stdout).toContain("-d")

    const install = runOperator(["install", "--help"])
    expect(install.exitCode).toBe(0)
    expect(install.stdout).toContain("--port")

  })

  test("offers browser authentication as both ii login and ii auth", () => {
    const root = runOperator(["--help"])
    const login = runOperator(["login", "--help"])
    const auth = runOperator(["auth", "--help"])

    expect(root.stdout).toContain("login, auth")
    for (const help of [login, auth]) {
      expect(help.exitCode).toBe(0)
      expect(help.stdout).toContain("[<email>]")
      expect(help.stdout).toContain("--no-open")
      expect(help.stdout).toContain("--timeout")
    }
  }, 30_000)

  test("shows arguments and flags for a specific command", () => {
    const help = runAgent(["search", "--help"])

    expect(help.exitCode).toBe(0)
    expect(help.stdout).toContain("query string")
    expect(help.stdout).toContain("--verbose")
    expect(help.stdout).toContain("--kind")
    // JSON is the only output. A human-readable summary that drops fields is
    // the failure mode this CLI exists to prevent: an agent acts on what it
    // sees, and what it saw was missing every discovery URL.
    expect(help.stdout).not.toContain("--text")
  })

  test("reports a missing integrations service instead of failing obscurely", () => {
    const result = runAgent(["integrations"])

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("No integrations service found")
  })

  test("agent execution cannot request operator authority", () => {
    const agentExecute = runAgent(["execute", "--help"])
    const operatorExecute = runOperator(["execute", "--help"])
    expect(agentExecute.stdout).not.toContain("--direct")
    expect(operatorExecute.stdout).toContain("--direct")
  })
})
