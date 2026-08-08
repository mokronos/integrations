import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Schema } from "effect"

const packageDirectory = join(dirname(fileURLToPath(import.meta.url)), "..")
const temporaryDirectories: string[] = []
const DependencyMap = Schema.Record(Schema.String, Schema.String)
const PackageManifest = Schema.Struct({
  dependencies: Schema.optional(DependencyMap),
  devDependencies: Schema.optional(DependencyMap),
  peerDependencies: Schema.optional(DependencyMap),
  optionalDependencies: Schema.optional(DependencyMap)
})

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true
  })))
})

describe("package architecture", () => {
  test("the authoring package does not depend on the integration executor", async () => {
    const manifest = Schema.decodeUnknownSync(Schema.fromJsonString(PackageManifest))(
      await readFile(join(packageDirectory, "package.json"), "utf8")
    )
    const dependencySections = [
      manifest.dependencies,
      manifest.devDependencies,
      manifest.peerDependencies,
      manifest.optionalDependencies
    ]

    expect(dependencySections.every((dependencies) =>
      dependencies?.["@mokronos/wfkit-executor"] === undefined
    )).toBe(true)
  })

  test("importing the runtime has no filesystem side effects", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wf-import-"))
    temporaryDirectories.push(directory)

    const process = Bun.spawn({
      cmd: ["bun", "-e", `await import(${JSON.stringify(join(packageDirectory, "src/runtime.ts"))})`],
      cwd: directory,
      stdout: "pipe",
      stderr: "pipe"
    })
    const exitCode = await process.exited
    const stderr = await new Response(process.stderr).text()

    expect(stderr).toBe("")
    expect(exitCode).toBe(0)
    expect(await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: directory }))).toEqual([])
  })
})
