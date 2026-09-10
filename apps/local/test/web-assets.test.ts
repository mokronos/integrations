import { describe, expect, it } from "@effect/vitest"
import path from "node:path"
import { Effect, FileSystem, Result } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { createWebAssets } from "../index.ts"
import type { WebAssets } from "../index.ts"
import { temporaryDirectory, testServices } from "./fixtures.ts"

/** A build output the way `bun run build` leaves one behind. */
const buildOutput = Effect.fnUntraced(function*() {
  const fs = yield* FileSystem.FileSystem
  const directory = yield* temporaryDirectory("web-assets-")
  yield* Effect.orDie(fs.writeFileString(
    path.join(directory, "index.html"),
    "<!doctype html><title>control</title>"
  ))
  yield* Effect.orDie(fs.makeDirectory(path.join(directory, "assets"), { recursive: true }))
  yield* Effect.orDie(fs.writeFileString(
    path.join(directory, "assets", "index-abc.js"),
    "console.log(1)"
  ))
  return directory
})

const served = Effect.flatMap(
  buildOutput(),
  (directory) => createWebAssets({ directories: [directory] })
)

/** Asks the assets for a path the way a browser would, and reports the miss. */
const ask = (assets: WebAssets, pathname: string): Effect.Effect<Response | undefined> =>
  assets.respond.pipe(
    Effect.provideService(
      HttpServerRequest.HttpServerRequest,
      HttpServerRequest.fromWeb(
        new Request(`http://control.test${pathname}`, { headers: { accept: "text/html" } })
      )
    ),
    Effect.result,
    Effect.map((outcome) =>
      Result.isSuccess(outcome) ? HttpServerResponse.toWeb(outcome.success) : undefined
    )
  )

const bodyOf = (response: Response | undefined) =>
  Effect.promise(() => response?.text() ?? Promise.resolve(""))

describe("control plane assets", () => {
  it.effect("falls back to the entry document for a client-side route", () =>
    Effect.gen(function*() {
      const assets = yield* served

      const response = yield* ask(assets, "/clients/cl_7")

      expect(response?.status).toBe(200)
      expect(yield* bodyOf(response)).toContain("<title>control</title>")
    }).pipe(Effect.provide(testServices)))

  it.effect("refuses to escape the build directory", () =>
    Effect.gen(function*() {
      const assets = yield* served

      // The URL parser folds "/../x" and its encoded spellings down to "/x", so
      // what has to hold is that the resolved file never leaves the build output:
      // a host path resolves inside the root, misses, and falls back to the SPA.
      for (const pathname of ["/../../etc/passwd", "/%2e%2e/%2e%2e/etc/passwd", "/etc/passwd"]) {
        expect(yield* bodyOf(yield* ask(assets, pathname))).not.toContain("root:")
      }
    }).pipe(Effect.provide(testServices)))

  it.effect("says what to build when there is nothing to serve", () =>
    Effect.gen(function*() {
      const empty = yield* temporaryDirectory("web-assets-missing-")

      const assets = yield* createWebAssets({ directories: [path.join(empty, "nope")] })
      const response = yield* ask(assets, "/")

      expect(assets.directory).toBeUndefined()
      expect(response?.status).toBe(503)
      expect(yield* bodyOf(response)).toContain("bun run --cwd apps/web build")
    }).pipe(Effect.provide(testServices)))
})
