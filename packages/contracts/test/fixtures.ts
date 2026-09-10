import * as BunServices from "@effect/platform-bun/BunServices"
import { Crypto, Effect, FileSystem, Layer, Scope } from "effect"
import { webCryptoLayer } from "../src/index.ts"

/**
 * Identifiers and secrets are minted through the Crypto service, so tests carry
 * the same platform implementation the components run on. A test that wants to
 * pin what gets minted provides its own layer over this one.
 */
export const testServices: Layer.Layer<Crypto.Crypto | FileSystem.FileSystem> = Layer.merge(
  webCryptoLayer,
  BunServices.layer
)

/** A directory that the test's scope removes when it ends. */
export const temporaryDirectory = (
  prefix: string
): Effect.Effect<string, never, FileSystem.FileSystem | Scope.Scope> =>
  Effect.flatMap(
    FileSystem.FileSystem,
    (fs) => Effect.orDie(fs.makeTempDirectoryScoped({ prefix }))
  )
