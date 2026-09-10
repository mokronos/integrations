import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { installLocal } from "../install-local.ts"

const directories: Array<string> = []

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe("local CLI installer", () => {
  test("refuses to overwrite an unrelated executable", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "integrations-install-"))
    directories.push(directory)
    const target = path.join(directory, "i")
    await writeFile(target, "#!/bin/sh\necho unrelated\n", { mode: 0o755 })

    await expect(installLocal({ directory })).rejects.toThrow("not a local integrations install")
    expect(await Bun.file(target).text()).toContain("unrelated")
  })
})
