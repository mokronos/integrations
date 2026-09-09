import path from "node:path"
import { serveGateway as serveGatewayApi } from "@integrations/gateway-api"
import type { RunningGateway, ServeOptions } from "@integrations/gateway-api"

export * from "@integrations/gateway-api"
export * from "@integrations/gateway-core"

const bundledWebDirectory = path.join(import.meta.dirname, "web")

export const serveGateway = (options: ServeOptions): Promise<RunningGateway> =>
  serveGatewayApi({
    ...options,
    webDirectory: options.webDirectory ?? bundledWebDirectory
  })
