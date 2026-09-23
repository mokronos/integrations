import path from "node:path"
import { serveGateway as serveGatewayApi } from "@integragents/gateway-api"
import type { RunningGateway, ServeOptions } from "@integragents/gateway-api"

export * from "@integragents/gateway-api"
export * from "@integragents/gateway-core"

const bundledWebDirectory = path.join(import.meta.dirname, "web")

export const serveGateway = (options: ServeOptions): Promise<RunningGateway> =>
  serveGatewayApi({
    ...options,
    webDirectory:
      options.webDirectory ??
      process.env["INTEGRATIONS_WEB_DIR"] ??
      bundledWebDirectory
  })
