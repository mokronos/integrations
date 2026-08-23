import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { ProviderItemId } from "@executor-js/sdk/core"
import { Effect } from "effect"
import { fileCredentialProvider } from "../src/credential-provider.ts"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true
  })))
})

describe("file credential provider", () => {
  test("serializes concurrent credential updates", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "wf-credentials-"))
    directories.push(directory)
    const provider = fileCredentialProvider(directory)
    const set = provider.set
    if (set === undefined) throw new Error("File credential provider must be writable")
    const first = ProviderItemId.make("first")
    const second = ProviderItemId.make("second")

    await Effect.runPromise(Effect.all([
      set(first, "alpha"),
      set(second, "beta")
    ], { concurrency: "unbounded" }))

    await expect(Effect.runPromise(provider.get(first))).resolves.toBe("alpha")
    await expect(Effect.runPromise(provider.get(second))).resolves.toBe("beta")
  })
})
