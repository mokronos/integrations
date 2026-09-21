import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Data, Effect, Option, Schema } from "effect"
import { Command, Flag } from "effect/unstable/cli"
import * as BunServices from "@effect/platform-bun/BunServices"

const repositoryRoot = path.resolve(import.meta.dirname, "..")

/**
 * Every manifest that carries the release version. They move together, so a
 * release either stamps all of them (nightly) or asserts they already agree
 * with the tag (stable).
 */
export const releasePackageFiles = [
  "package.json",
  "packages/integrations/package.json",
  "packages/contracts/package.json",
  "packages/observability/package.json",
  "packages/core/gateway/package.json",
  "packages/core/api/package.json",
  "apps/ts/package.json",
  "apps/local/package.json",
  "apps/cli/package.json"
] as const

/** The version constant the gateway reports over the wire. */
export const gatewayVersionFile = "packages/core/api/src/version.ts"

/**
 * The packages published as release assets. Consumers install them from the
 * release download URL, so this list is also the order they are packed in.
 */
export const publishablePackageDirectories = [
  "packages/contracts",
  "packages/integrations",
  "packages/core/gateway"
] as const

/**
 * `nightly` is the prerelease train cut from `main` on a schedule, `stable` is
 * cut from a `vX.Y.Z` tag push.
 */
export const ReleaseChannel = Schema.Literals(["stable", "nightly"])
export type ReleaseChannel = typeof ReleaseChannel.Type

export interface ReleaseMetadata {
  readonly channel: ReleaseChannel
  readonly version: string
  readonly tag: string
  readonly name: string
  readonly isPrerelease: boolean
  readonly makeLatest: boolean
}

export class InvalidReleaseVersionError extends Data.TaggedError("InvalidReleaseVersionError")<{
  readonly version: string
}> {
  override get message(): string {
    return `Invalid release version '${this.version}'.`
  }
}

export class MissingReleaseFlagError extends Data.TaggedError("MissingReleaseFlagError")<{
  readonly channel: ReleaseChannel
  readonly flag: string
}> {
  override get message(): string {
    return `A ${this.channel} release needs --${this.flag}.`
  }
}

export class ReleaseVersionMismatchError extends Data.TaggedError("ReleaseVersionMismatchError")<{
  readonly file: string
  readonly expected: string
  readonly actual: string
}> {
  override get message(): string {
    return `${this.file} declares '${this.actual}', expected '${this.expected}'.`
  }
}

export class ReleaseVersionNotFoundError extends Data.TaggedError("ReleaseVersionNotFoundError")<{
  readonly file: string
}> {
  override get message(): string {
    return `${this.file} has no top-level version declaration to stamp.`
  }
}

const semverPattern = /^(\d+)\.(\d+)\.(\d+)$/
const releaseVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const nightlyDatePattern = /^\d{8}$/
const commitShaPattern = /^[0-9a-f]{7,40}$/i

/**
 * The top level of a manifest is the only place indented by exactly two
 * spaces, which keeps the stamp away from any nested `version` key.
 */
const manifestVersionPattern = /^ {2}"version": "[^"]*"/m
const gatewayVersionPattern = /^export const gatewayVersion = ".*"$/m

const PackageJson = Schema.Struct({ version: Schema.NonEmptyString })
const decodePackageJson = Schema.decodeUnknownSync(Schema.fromJsonString(PackageJson))

/** Drops any prerelease or build suffix, leaving the `X.Y.Z` core. */
export const stableCore = (version: string): string => version.replace(/[-+].*$/, "")

/**
 * The nightly train previews the next patch, so `0.2.3` in the manifests
 * becomes the `0.2.4-nightly.*` series.
 */
export const nextPatchVersion = (version: string): Effect.Effect<string, InvalidReleaseVersionError> => {
  const match = semverPattern.exec(stableCore(version))
  if (match === null) return Effect.fail(new InvalidReleaseVersionError({ version }))
  const [, major, minor, patch] = match
  return Effect.succeed(`${major}.${minor}.${Number(patch) + 1}`)
}

export const nightlyMetadata = (
  baseVersion: string,
  date: string,
  runNumber: number,
  sha: string
): Effect.Effect<ReleaseMetadata, InvalidReleaseVersionError> => {
  const version = `${baseVersion}-nightly.${date}.${runNumber}`
  const wellFormed = semverPattern.test(baseVersion) &&
    nightlyDatePattern.test(date) &&
    commitShaPattern.test(sha) &&
    Number.isInteger(runNumber) &&
    runNumber >= 1
  if (!wellFormed) return Effect.fail(new InvalidReleaseVersionError({ version }))
  return Effect.succeed({
    channel: "nightly",
    version,
    tag: `v${version}`,
    name: `integrations Nightly ${version} (${sha.slice(0, 12)})`,
    isPrerelease: true,
    makeLatest: false
  })
}

export const stableMetadata = (raw: string): Effect.Effect<ReleaseMetadata, InvalidReleaseVersionError> => {
  const version = raw.replace(/^v/, "")
  if (!releaseVersionPattern.test(version)) return Effect.fail(new InvalidReleaseVersionError({ version: raw }))
  const isFinal = semverPattern.test(version)
  return Effect.succeed({
    channel: "stable",
    version,
    tag: `v${version}`,
    name: `integrations v${version}`,
    isPrerelease: !isFinal,
    makeLatest: isFinal
  })
}

/** Rewrites a manifest's own version, leaving every other byte untouched. */
export const renderManifestVersion = (
  file: string,
  source: string,
  version: string
): Effect.Effect<string, ReleaseVersionNotFoundError> =>
  manifestVersionPattern.test(source)
    ? Effect.succeed(source.replace(manifestVersionPattern, `  "version": "${version}"`))
    : Effect.fail(new ReleaseVersionNotFoundError({ file }))

/** Rewrites the gateway version constant, leaving the rest of the module alone. */
export const renderGatewayVersion = (
  source: string,
  version: string
): Effect.Effect<string, ReleaseVersionNotFoundError> =>
  gatewayVersionPattern.test(source)
    ? Effect.succeed(source.replace(gatewayVersionPattern, `export const gatewayVersion = "${version}"`))
    : Effect.fail(new ReleaseVersionNotFoundError({ file: gatewayVersionFile }))

const read = (file: string): string => readFileSync(path.join(repositoryRoot, file), "utf8")
const write = (file: string, contents: string): void => writeFileSync(path.join(repositoryRoot, file), contents)

const requireFlag = <A>(
  value: Option.Option<A>,
  channel: ReleaseChannel,
  flag: string
): Effect.Effect<A, MissingReleaseFlagError> =>
  Option.match(value, {
    onNone: () => Effect.fail(new MissingReleaseFlagError({ channel, flag })),
    onSome: Effect.succeed
  })

const emit = (metadata: ReleaseMetadata): Effect.Effect<void> =>
  Effect.sync(() => {
    const lines = [
      `channel=${metadata.channel}`,
      `version=${metadata.version}`,
      `tag=${metadata.tag}`,
      `name=${metadata.name}`,
      `is_prerelease=${metadata.isPrerelease}`,
      `make_latest=${metadata.makeLatest}`
    ]
    const outputPath = process.env["GITHUB_OUTPUT"]
    if (outputPath === undefined) {
      for (const line of lines) console.log(line)
      return
    }
    writeFileSync(outputPath, `${lines.join("\n")}\n`, { flag: "a" })
  })

const resolveCommand = Command.make("resolve", {
  channel: Flag.choice("channel", ["stable", "nightly"]),
  version: Flag.optional(Flag.string("version")),
  date: Flag.optional(Flag.string("date")),
  runNumber: Flag.optional(Flag.integer("run-number")),
  sha: Flag.optional(Flag.string("sha"))
}, (flags) =>
  Effect.gen(function*() {
    if (flags.channel === "stable") {
      const raw = yield* requireFlag(flags.version, "stable", "version")
      return yield* emit(yield* stableMetadata(raw))
    }
    const baseVersion = yield* nextPatchVersion(decodePackageJson(read("package.json")).version)
    const date = yield* requireFlag(flags.date, "nightly", "date")
    const runNumber = yield* requireFlag(flags.runNumber, "nightly", "run-number")
    const sha = yield* requireFlag(flags.sha, "nightly", "sha")
    return yield* emit(yield* nightlyMetadata(baseVersion, date, runNumber, sha))
  }))

const applyCommand = Command.make("apply", { version: Flag.string("version") }, (flags) =>
  Effect.gen(function*() {
    const version = flags.version.replace(/^v/, "")
    if (!releaseVersionPattern.test(version)) return yield* new InvalidReleaseVersionError({ version: flags.version })
    for (const file of releasePackageFiles) {
      write(file, yield* renderManifestVersion(file, read(file), version))
    }
    write(gatewayVersionFile, yield* renderGatewayVersion(read(gatewayVersionFile), version))
    yield* Effect.log(`stamped ${version} across ${releasePackageFiles.length} manifest(s)`)
  }))

const verifyCommand = Command.make("verify", { version: Flag.string("version") }, (flags) =>
  Effect.gen(function*() {
    const version = flags.version.replace(/^v/, "")
    for (const file of releasePackageFiles) {
      const actual = decodePackageJson(read(file)).version
      if (actual !== version) return yield* new ReleaseVersionMismatchError({ file, expected: version, actual })
    }
    const source = read(gatewayVersionFile)
    if (!source.includes(`export const gatewayVersion = "${version}"`)) {
      return yield* new ReleaseVersionMismatchError({
        file: gatewayVersionFile,
        expected: version,
        actual: source.trim()
      })
    }
    yield* Effect.log(`verified ${version} across ${releasePackageFiles.length} manifest(s)`)
  }))

const packagesCommand = Command.make("packages", {}, () =>
  Effect.sync(() => {
    for (const directory of publishablePackageDirectories) console.log(directory)
  }))

const command = Command.make("release-version").pipe(
  Command.withSubcommands([resolveCommand, applyCommand, verifyCommand, packagesCommand])
)

if (import.meta.main) {
  Command.runWith(command, { version: "0.2.0" })(process.argv.slice(2)).pipe(
    Effect.provide(BunServices.layer),
    Effect.runPromise
  )
}
