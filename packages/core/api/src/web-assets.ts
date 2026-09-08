import { stat } from "node:fs/promises"
import path from "node:path"

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
  respond(pathname: string): Promise<Response | undefined>
}

const notBuiltMessage = (directory: string): string =>
  `The integrations control plane has not been built.\n` +
  `  ${directory}\n\n` +
  `Build it with: bun run --cwd apps/web build\n`

export interface WebAssetsOptions {
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
      const contained = requested === root || requested.startsWith(`${root}${path.sep}`)
      if (!contained) return undefined

      const direct = pathname === "/" ? undefined : await fileResponse(requested)
      if (direct !== undefined) return direct

      if (path.extname(pathname).length > 0) return undefined
      return await fileResponse(indexPath)
    }
  }
}
