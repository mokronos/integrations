import { run } from "./effect.ts"
import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect, Result } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { createWebAssets } from "../index.ts"
import type { WebAssets } from "../index.ts"

const directories: Array<string> = []

afterEach(async () => {
  await run(Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  ))
})

const buildOutput = async (): Promise<string> => {
  const directory = await run(mkdtemp(path.join(tmpdir(), "wf-web-assets-")))
  directories.push(directory)
  await run(writeFile(path.join(directory, "index.html"), "<!doctype html><title>control</title>"))
  await run(mkdir(path.join(directory, "assets"), { recursive: true }))
  await run(writeFile(path.join(directory, "assets", "index-abc.js"), "console.log(1)"))
  return directory
}

/** Asks the assets for a path the way a browser would, and reports the miss. */
const ask = (assets: WebAssets, pathname: string): Promise<Response | undefined> =>
  Effect.runPromise(
    assets.respond.pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(
          new Request(`http://control.test${pathname}`, { headers: { accept: "text/html" } })
        )
      ),
      Effect.result,
      Effect.map((outcome) =>
        Result.isSuccess(outcome)
          ? HttpServerResponse.toWeb(outcome.success)
          : undefined
      )
    )
  )

describe("control plane assets", () => {
  test("falls back to the entry document for a client-side route", async () => {
    const assets = await run(createWebAssets({ directories: [await run(buildOutput())] }))

    const response = await ask(assets, "/clients/cl_7")

    expect(response?.status).toBe(200)
    expect(await run(response?.text())).toContain("<title>control</title>")
  })

  test("refuses to escape the build directory", async () => {
    const assets = await run(createWebAssets({ directories: [await run(buildOutput())] }))

    // The URL parser folds "/../x" and its encoded spellings down to "/x", so
    // what has to hold is that the resolved file never leaves the build output:
    // a host path resolves inside the root, misses, and falls back to the SPA.
    for (const pathname of ["/../../etc/passwd", "/%2e%2e/%2e%2e/etc/passwd", "/etc/passwd"]) {
      const body = await run((await ask(assets, pathname))?.text())
      expect(body ?? "").not.toContain("root:")
    }
  })

  test("says what to build when there is nothing to serve", async () => {
    const empty = await run(mkdtemp(path.join(tmpdir(), "wf-web-missing-")))
    directories.push(empty)

    const assets = await run(createWebAssets({ directories: [path.join(empty, "nope")] }))
    const response = await ask(assets, "/")

    expect(assets.directory).toBeUndefined()
    expect(response?.status).toBe(503)
    expect(await run(response?.text())).toContain("bun run --cwd apps/web build")
  })
})
