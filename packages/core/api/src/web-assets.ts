import path from "node:path"
// Imported by subpath: the package barrel reaches BunRedis, whose `bun`
// import the Cloudflare bundler cannot resolve.
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem"
import * as BunHttpPlatform from "@effect/platform-bun/BunHttpPlatform"
import * as BunPath from "@effect/platform-bun/BunPath"
import { Config, Effect, FileSystem, Layer, Option, Result } from "effect"
import {
  HttpServerError,
  HttpServerRequest,
  HttpServerResponse,
  HttpStaticServer
} from "effect/unstable/http"

const webAssetsDirectory = (): string =>
  path.resolve(import.meta.dirname ?? process.cwd(), "../../../../apps/web/dist")

/**
 * Serving the built control plane needs a real filesystem, which the gateway's
 * own platform layer deliberately does not carry. The static app is built with
 * the Bun platform baked in, so it leaves the caller nothing to provide beyond
 * the request itself.
 */
const platform = Layer.mergeAll(
  BunFileSystem.layer,
  BunPath.layer,
  BunHttpPlatform.layer.pipe(Layer.provide(BunFileSystem.layer))
)

export interface WebAssets {
  readonly directory: string | undefined
  /**
   * Resolves the request against the build output. Fails when nothing there
   * matches, which the caller reads as "not an asset, keep looking".
   */
  readonly respond: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    HttpServerError.HttpServerError,
    HttpServerRequest.HttpServerRequest
  >
}

const notBuiltMessage = (directory: string): string =>
  `The integrations control plane has not been built.\n` +
  `  ${directory}\n\n` +
  `Build it with: bun run --cwd apps/web build\n`

export interface WebAssetsOptions {
  readonly directories?: ReadonlyArray<string>
}

export const createWebAssets = (
  options: WebAssetsOptions = {}
): Effect.Effect<WebAssets> =>
  Effect.gen(function*() {
    const configured = yield* Config.option(Config.string("INTEGRATIONS_WEB_DIR"))
    const directory =
      options.directories?.[0] ??
      Option.getOrUndefined(configured) ??
      webAssetsDirectory()

    const fileSystem = yield* FileSystem.FileSystem
    const built = yield* Effect.result(fileSystem.stat(directory))
    if (Result.isFailure(built) || built.success.type !== "Directory") {
      return {
        directory: undefined,
        respond: Effect.succeed(
          HttpServerResponse.text(notBuiltMessage(directory), { status: 503 })
        )
      }
    }

    return {
      directory,
      respond: yield* HttpStaticServer.make({
        root: directory,
        index: "index.html",
        spa: true
      })
    }
  }).pipe(Effect.provide(platform), Effect.orDie)
