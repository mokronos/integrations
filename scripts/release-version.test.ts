import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import {
  gatewayVersionFile,
  nextPatchVersion,
  nightlyMetadata,
  publishablePackageDirectories,
  releasePackageFiles,
  renderGatewayVersion,
  renderManifestVersion,
  renderReleaseDependencies,
  stableCore,
  stableMetadata
} from "./release-version.ts"

describe("stableCore", () => {
  it("keeps a released version untouched", () => {
    assert.equal(stableCore("0.2.3"), "0.2.3")
  })

  it("drops prerelease and build metadata", () => {
    assert.equal(stableCore("0.2.4-nightly.20260921.7"), "0.2.4")
    assert.equal(stableCore("0.2.4+build.1"), "0.2.4")
  })
})

describe("nextPatchVersion", () => {
  it.effect("previews the next patch", () =>
    Effect.gen(function*() {
      assert.equal(yield* nextPatchVersion("0.2.3"), "0.2.4")
      assert.equal(yield* nextPatchVersion("1.9.0-nightly.20260921.1"), "1.9.1")
    }))

  it.effect("rejects a version that is not semver", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(nextPatchVersion("0.2"))
      assert.equal(error._tag, "InvalidReleaseVersionError")
    }))
})

describe("nightlyMetadata", () => {
  it.effect("builds a dated, run-numbered prerelease", () =>
    Effect.gen(function*() {
      const metadata = yield* nightlyMetadata("0.2.4", "20260921", 321, "abcdef1234567890")
      assert.deepStrictEqual(metadata, {
        channel: "nightly",
        version: "0.2.4-nightly.20260921.321",
        tag: "v0.2.4-nightly.20260921.321",
        name: "integrations Nightly 0.2.4-nightly.20260921.321 (abcdef123456)",
        isPrerelease: true,
        makeLatest: false
      })
    }))

  it.effect("rejects malformed build coordinates", () =>
    Effect.gen(function*() {
      const badDate = yield* Effect.flip(nightlyMetadata("0.2.4", "2026-09-21", 1, "abcdef1"))
      assert.equal(badDate._tag, "InvalidReleaseVersionError")
      const badSha = yield* Effect.flip(nightlyMetadata("0.2.4", "20260921", 1, "zzzz"))
      assert.equal(badSha._tag, "InvalidReleaseVersionError")
      const badRunNumber = yield* Effect.flip(nightlyMetadata("0.2.4", "20260921", 0, "abcdef1"))
      assert.equal(badRunNumber._tag, "InvalidReleaseVersionError")
      const badBase = yield* Effect.flip(nightlyMetadata("0.2.4-nightly.20260921.1", "20260921", 1, "abcdef1"))
      assert.equal(badBase._tag, "InvalidReleaseVersionError")
    }))
})

describe("stableMetadata", () => {
  it.effect("marks a final version as latest", () =>
    Effect.gen(function*() {
      const metadata = yield* stableMetadata("v0.2.3")
      assert.deepStrictEqual(metadata, {
        channel: "stable",
        version: "0.2.3",
        tag: "v0.2.3",
        name: "integrations v0.2.3",
        isPrerelease: false,
        makeLatest: true
      })
    }))

  it.effect("keeps a prerelease tag off the latest pointer", () =>
    Effect.gen(function*() {
      const metadata = yield* stableMetadata("v0.3.0-rc.1")
      assert.isTrue(metadata.isPrerelease)
      assert.isFalse(metadata.makeLatest)
    }))

  it.effect("rejects a tag that is not a release version", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(stableMetadata("nightly"))
      assert.equal(error._tag, "InvalidReleaseVersionError")
    }))
})

describe("renderManifestVersion", () => {
  const manifest = `{
  "name": "@mokronos/integrations-contracts",
  "version": "0.2.3",
  "dependencies": {
    "oas": "^38.3.0"
  },
  "engines": {
    "version": "nested, must not move"
  }
}
`

  it.effect("stamps only the top-level version", () =>
    Effect.gen(function*() {
      const stamped = yield* renderManifestVersion("packages/contracts/package.json", manifest, "0.2.4-nightly.20260921.1")
      assert.include(stamped, `"version": "0.2.4-nightly.20260921.1"`)
      assert.include(stamped, `"version": "nested, must not move"`)
      assert.isTrue(stamped.endsWith("}\n"))
    }))

  it.effect("fails when a manifest declares no version", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(renderManifestVersion("apps/cli/package.json", `{\n  "name": "x"\n}\n`, "0.2.4"))
      assert.equal(error._tag, "ReleaseVersionNotFoundError")
    }))
})

describe("renderGatewayVersion", () => {
  it.effect("rewrites the reported gateway version", () =>
    Effect.gen(function*() {
      const rewritten = yield* renderGatewayVersion(`export const gatewayVersion = "0.2.3"\n`, "0.2.4")
      assert.equal(rewritten, `export const gatewayVersion = "0.2.4"\n`)
    }))

  it.effect("fails when the constant is gone", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(renderGatewayVersion(`export const other = "0.2.3"\n`, "0.2.4"))
      assert.equal(error.file, gatewayVersionFile)
    }))
})

describe("release surface", () => {
  it("packs every publishable package from a coordinated manifest", () => {
    for (const directory of publishablePackageDirectories) {
      assert.include(releasePackageFiles, `${directory}/package.json`)
    }
  })
})

describe("renderReleaseDependencies", () => {
  const versions = new Map([
    ["@mokronos/integrations-contracts", "0.3.1-nightly.20260921.4"],
    ["@mokronos/integrations-host", "0.3.1-nightly.20260921.4"]
  ])

  const manifest = `{
  "name": "@mokronos/integrations-gateway-core",
  "dependencies": {
    "@cfworker/json-schema": "^4.1.1",
    "@mokronos/integrations-contracts": "workspace:^",
    "@mokronos/integrations-host": "workspace:*"
  },
  "peerDependencies": {
    "effect": "catalog:"
  }
}
`

  it.effect("pins every workspace dependency to the published range", () =>
    Effect.gen(function*() {
      const linked = yield* renderReleaseDependencies("packages/core/gateway/package.json", manifest, versions)
      assert.include(linked, `"@mokronos/integrations-contracts": "^0.3.1-nightly.20260921.4"`)
      assert.include(linked, `"@mokronos/integrations-host": "^0.3.1-nightly.20260921.4"`)
      assert.include(linked, `"@cfworker/json-schema": "^4.1.1"`)
      assert.include(linked, `"effect": "catalog:"`)
    }))

  it.effect("fails on a workspace dependency the release does not publish", () =>
    Effect.gen(function*() {
      const unpublished = `{\n  "dependencies": { "@mokronos/integrations-client": "workspace:^" }\n}\n`
      const error = yield* Effect.flip(renderReleaseDependencies("apps/ts/package.json", unpublished, versions))
      assert.equal(error._tag, "UnresolvedWorkspaceDependencyError")
      assert.include(error.message, "@mokronos/integrations-client")
    }))
})
