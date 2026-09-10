import { describe, expect, it } from "@effect/vitest"
import path from "node:path"
import { Effect, FileSystem } from "effect"
import { installLocal } from "../install-local.ts"
import { temporaryDirectory, testServices } from "./fixtures.ts"

describe("local CLI installer", () => {
  it.effect("refuses to overwrite an unrelated executable", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* temporaryDirectory("integrations-install-")
      const target = path.join(directory, "i")
      yield* Effect.orDie(fs.writeFileString(target, "#!/bin/sh\necho unrelated\n"))

      const outcome = yield* Effect.exit(
        Effect.promise(() => installLocal({ directory }))
      )

      expect(outcome._tag).toBe("Failure")
      expect(yield* Effect.orDie(fs.readFileString(target))).toContain("unrelated")
    }).pipe(Effect.provide(testServices)))
})
