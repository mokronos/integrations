import { stat } from "node:fs/promises"
import path from "node:path"

/** Serving the control plane's built assets.
 *
 * These are read from disk rather than embedded as base64 the way `wf` does it:
 * `wf` compiles to a single-file binary that has no disk to read from, while the
 * gateway ships as an ordinary package whose files are still there at runtime.
 */

/** A Map rather than an object literal: the key is an arbitrary file extension,
 *  so the lookup has to accept any string, and Map keeps that honest without an
 *  index signature that would erase which extensions are actually known. */
const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".ico", "image/x-icon"],
  [".woff2", "font/woff2"],
  [".woff", "font/woff"],
  [".map", "application/json; charset=utf-8"]
])

const contentTypeFor = (location: string): string =>
  contentTypes.get(path.extname(location).toLowerCase()) ?? "application/octet-stream"

/** Resolved on first use, not at module load: hosts without a filesystem
 *  (Cloudflare Workers) have no `import.meta.dirname`, and this module rides
 *  along in bundles that never serve assets from disk. */
const webAssetsDirectory = (): string =>
  path.resolve(import.meta.dirname ?? process.cwd(), "../../../../apps/web/dist")

const directoryExists = async (location: string): Promise<boolean> => {
  try {
    return (await stat(location)).isDirectory()
  } catch {
    return false
  }
}

export interface WebAssets {
  readonly directory: string | undefined
  /** `undefined` for a path this bundle does not serve, so the caller decides
   *  what a miss means rather than having a 404 forced on it. */
  respond(pathname: string): Promise<Response | undefined>
}

const notBuiltMessage = (directory: string): string =>
  `The integrations control plane has not been built.\n` +
  `  ${directory}\n\n` +
  `Build it with: bun run --cwd apps/web build\n`

export interface WebAssetsOptions {
  /** Where to look, in order. Defaults to the resolution above; tests pass an
   *  explicit list so a built working tree cannot mask the not-built case. */
  readonly directories?: ReadonlyArray<string>
}

export const createWebAssets = async (
  options: WebAssetsOptions = {}
): Promise<WebAssets> => {
  const directory =
    options.directories?.[0] ??
    process.env["INTEGRATIONS_WEB_DIR"] ??
    webAssetsDirectory()

  if (!(await directoryExists(directory))) {
    return {
      directory: undefined,
      respond: async () =>
        new Response(notBuiltMessage(directory), {
          status: 503,
          headers: { "content-type": "text/plain; charset=utf-8" }
        })
    }
  }

  const root = directory
  const indexPath = path.join(root, "index.html")

  const fileResponse = async (location: string): Promise<Response | undefined> => {
    const file = Bun.file(location)
    if (!(await file.exists())) return undefined
    return new Response(file, { headers: { "content-type": contentTypeFor(location) } })
  }

  return {
    directory: root,
    respond: async (pathname) => {
      const requested = path.resolve(root, `.${pathname}`)
      // `..` in a URL is normally collapsed by the client, but nothing
      // guarantees the request came from one.
      const contained = requested === root || requested.startsWith(`${root}${path.sep}`)
      if (!contained) return undefined

      const direct = pathname === "/" ? undefined : await fileResponse(requested)
      if (direct !== undefined) return direct

      // Client-side routes are real URLs the user can reload or link to, and
      // none of them exist on disk. Anything that looks like a missing asset is
      // still a 404 — silently serving HTML for a broken script tag turns a
      // build mistake into a blank page with no explanation.
      if (path.extname(pathname).length > 0) return undefined
      return await fileResponse(indexPath)
    }
  }
}
