import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  installLocal,
  parseInstallOptions,
  repositoryDirectory
} from "../install-local.ts"

const directories: Array<string> = []

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "integrations-install-"))
  directories.push(directory)
  return directory
}

describe("local CLI installer", () => {
  test("installs executable source shims for exactly i and ii", async () => {
    const directory = await temporaryDirectory()
    await installLocal({ directory })

    const agent = await Bun.file(path.join(directory, "i")).text()
    const operator = await Bun.file(path.join(directory, "ii")).text()
    expect(agent).toContain(path.join(repositoryDirectory, "apps/cli/src/agent.ts"))
    expect(operator).toContain(path.join(repositoryDirectory, "apps/cli/src/main.ts"))
    expect((await stat(path.join(directory, "i"))).mode & 0o111).not.toBe(0)
    expect((await stat(path.join(directory, "ii"))).mode & 0o111).not.toBe(0)
    expect(await Bun.file(path.join(directory, "integrations")).exists()).toBe(false)

    const agentVersion = Bun.spawn({
      cmd: [path.join(directory, "i"), "--version"],
      stdout: "pipe",
      stderr: "pipe"
    })
    const operatorVersion = Bun.spawn({
      cmd: [path.join(directory, "ii"), "--version"],
      stdout: "pipe",
      stderr: "pipe"
    })
    expect(await agentVersion.exited).toBe(0)
    expect((await new Response(agentVersion.stdout).text()).trim()).toBe("i v0.2.0")
    expect(await operatorVersion.exited).toBe(0)
    expect((await new Response(operatorVersion.stdout).text()).trim()).toBe("ii v0.2.0")
  })

  test("replaces an older managed shim", async () => {
    const directory = await temporaryDirectory()
    const target = path.join(directory, "i")
    await writeFile(
      target,
      "# Local development install of i, written by: bun run install:local\nold\n"
    )

    await installLocal({ directory })
    expect(await Bun.file(target).text()).toContain(repositoryDirectory)
  })

  test("refuses to overwrite an unrelated executable", async () => {
    const directory = await temporaryDirectory()
    const target = path.join(directory, "i")
    await writeFile(target, "#!/bin/sh\necho unrelated\n", { mode: 0o755 })

    await expect(installLocal({ directory })).rejects.toThrow("not a local integrations install")
    expect(await Bun.file(target).text()).toContain("unrelated")
  })

  test("parses an explicit destination", async () => {
    const directory = await temporaryDirectory()
    expect(await parseInstallOptions(["--dir", directory])).toEqual({ directory })
  })
})
