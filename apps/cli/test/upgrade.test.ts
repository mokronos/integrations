import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test } from "bun:test"
import {
  describeInstall,
  latestPublishedVersion,
  managerFor,
  packageOwner,
  upgradeCli,
  upgradeCommand
} from "../src/upgrade.ts"

const repoRoot = path.resolve(import.meta.dir, "../../..")
const cliEntry = path.join(repoRoot, "apps", "cli", "src", "main.ts")

const directories: Array<string> = []
const servers: Array<ReturnType<typeof Bun.serve>> = []
const restoreRegistry = process.env["npm_config_registry"]

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true)
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
  if (restoreRegistry === undefined) delete process.env["npm_config_registry"]
  else process.env["npm_config_registry"] = restoreRegistry
})

const temporary = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "integrations-upgrade-"))
  directories.push(directory)
  return directory
}

/** A registry that answers for exactly the versions a test declares. Cheaper and
 *  more honest than stubbing fetch: the code under test does real HTTP. */
const startRegistry = (versions: Readonly<Record<string, string>>): string => {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => {
      const name = decodeURIComponent(new URL(request.url).pathname.replace(/^\//, "").replace(/\/latest$/, ""))
      const version = versions[name]
      return version === undefined
        ? new Response("{}", { status: 404 })
        : Response.json({ name, version })
    }
  })
  servers.push(server)
  return `http://127.0.0.1:${server.port}`
}

describe("install detection", () => {
  test("attributes files to the outermost package that owns them", () => {
    expect(packageOwner("/home/me/.bun/install/global/node_modules/@mokronos/integrations-cli/src/main.ts"))
      .toEqual({
        name: "@mokronos/integrations-cli",
        root: "/home/me/.bun/install/global/node_modules/@mokronos/integrations-cli"
      })
    expect(packageOwner("/usr/lib/node_modules/somecli/bin/cli.js")?.name).toBe("somecli")
    // A nested tree belongs to a dependency; upgrading that in place would be
    // undone by the next install of the package that owns it.
    expect(packageOwner("/usr/lib/node_modules/@mokronos/wf/node_modules/@mokronos/wf-linux-x64/bin/wf")?.name)
      .toBe("@mokronos/wf")
    expect(packageOwner("/home/me/projects/wf/apps/cli/src/main.ts")).toBeUndefined()
  })

  test("reads the manager off the tree it installs into", () => {
    expect(managerFor("/home/me/.bun/install/global/node_modules/@mokronos/integrations-cli")).toBe("bun")
    expect(managerFor("/usr/lib/node_modules/@mokronos/wf")).toBe("npm")
    expect(managerFor("/home/me/.local/share/pnpm/global/5/node_modules/@mokronos/wf")).toBe("pnpm")
    expect(managerFor("/home/me/.yarn/global/node_modules/@mokronos/wf")).toBe("yarn")
    expect(managerFor("/opt/something/bin")).toBeUndefined()
  })

  test("upgrades with the manager's own global command", () => {
    expect(upgradeCommand("bun", "@mokronos/wf", "1.2.3"))
      .toEqual(["bun", "add", "--global", "@mokronos/wf@1.2.3"])
    expect(upgradeCommand("npm", "@mokronos/wf", "1.2.3"))
      .toEqual(["npm", "install", "--global", "@mokronos/wf@1.2.3"])
    expect(upgradeCommand("pnpm", "@mokronos/wf", "1.2.3"))
      .toEqual(["pnpm", "add", "--global", "@mokronos/wf@1.2.3"])
    expect(upgradeCommand("yarn", "@mokronos/wf", "1.2.3"))
      .toEqual(["yarn", "global", "add", "@mokronos/wf@1.2.3"])
  })

  test("recognises a source checkout, a global install, and neither", async () => {
    expect(await describeInstall({ entry: cliEntry, executable: "/home/me/.bun/bin/bun" }))
      .toEqual({ _tag: "workspace", repository: repoRoot })

    const global_ = await temporary()
    const installed = path.join(global_, ".bun", "install", "global", "node_modules", "@mokronos", "integrations-cli")
    await mkdir(path.join(installed, "src"), { recursive: true })
    expect(await describeInstall({
      entry: path.join(installed, "src", "main.ts"),
      executable: "/home/me/.bun/bin/bun"
    })).toEqual({ _tag: "package", manager: "bun", owner: { name: "@mokronos/integrations-cli", root: installed } })

    // A compiled binary: the entry point is virtual, so where the executable
    // lives is the only evidence of how it was installed.
    const wrapper = path.join(global_, "lib", "node_modules", "@mokronos", "wf")
    await mkdir(path.join(wrapper, "bin"), { recursive: true })
    expect(await describeInstall({
      entry: "/$bunfs/root/wf",
      executable: path.join(wrapper, "bin", "wf")
    })).toEqual({ _tag: "package", manager: "npm", owner: { name: "@mokronos/wf", root: wrapper } })

    const loose = await temporary()
    expect(await describeInstall({
      entry: path.join(loose, "cli.ts"),
      executable: "/home/me/.bun/bin/bun"
    })).toEqual({ _tag: "unknown", location: path.join(loose, "cli.ts") })
  })
})

describe("published versions", () => {
  test("reads the latest version, and reports an unpublished package as absent", async () => {
    const registry = startRegistry({ "@mokronos/wf": "9.9.9" })
    const environment = { npm_config_registry: registry }

    expect(await latestPublishedVersion("@mokronos/wf", environment)).toBe("9.9.9")
    expect(await latestPublishedVersion("@mokronos/integrations-cli", environment)).toBeUndefined()
  })
})

describe("upgradeCli", () => {
  const globalInstall = async (name: string): Promise<string> => {
    const directory = await temporary()
    const installed = path.join(directory, ".bun", "install", "global", "node_modules", ...name.split("/"))
    await mkdir(path.join(installed, "src"), { recursive: true })
    await writeFile(
      path.join(installed, "package.json"),
      JSON.stringify({ name, version: "0.2.0" })
    )
    return path.join(installed, "src", "main.ts")
  }

  test("does nothing when the installed version is the published one", async () => {
    process.env["npm_config_registry"] = startRegistry({ "@mokronos/wf": "0.2.0" })
    const entry = await globalInstall("@mokronos/wf")

    const result = await upgradeCli({
      packageName: "@mokronos/wf",
      currentVersion: "0.2.0",
      command: "wf upgrade",
      check: false,
      pull: false,
      probe: { entry, executable: "/home/me/.bun/bin/bun" }
    })

    expect(result.changed).toBe(false)
    expect(result.lines.join("\n")).toContain("Already on the latest version (0.2.0)")
  })

  test("refuses to upgrade a package that is not published", async () => {
    process.env["npm_config_registry"] = startRegistry({})
    const entry = await globalInstall("@mokronos/integrations-cli")

    await expect(upgradeCli({
      packageName: "@mokronos/integrations-cli",
      currentVersion: "0.2.0",
      command: "integrations upgrade",
      check: false,
      pull: false,
      probe: { entry, executable: "/home/me/.bun/bin/bun" }
    })).rejects.toThrow("not published yet")
  })

  test("reports an available upgrade under --check without installing it", async () => {
    process.env["npm_config_registry"] = startRegistry({ "@mokronos/wf": "1.0.0" })
    const entry = await globalInstall("@mokronos/wf")

    const result = await upgradeCli({
      packageName: "@mokronos/wf",
      currentVersion: "0.2.0",
      command: "wf upgrade",
      check: true,
      pull: false,
      probe: { entry, executable: "/home/me/.bun/bin/bun" }
    })

    expect(result.changed).toBe(false)
    expect(result.lines.join("\n")).toContain("1.0.0 is available")
  })

  test("a source install says how to update itself and changes nothing", async () => {
    const result = await upgradeCli({
      packageName: "@mokronos/integrations-cli",
      currentVersion: "0.2.0",
      command: "integrations upgrade",
      check: false,
      pull: false,
      probe: { entry: cliEntry, executable: "/home/me/.bun/bin/bun" }
    })

    expect(result.changed).toBe(false)
    expect(result.lines.join("\n")).toContain("--pull")
  })
})
