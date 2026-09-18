import path from "node:path"
import { serveGateway as serveGatewayApi } from "@mokronos/integrations-gateway-api"
import type { RunningGateway, ServeOptions } from "@mokronos/integrations-gateway-api"

export * from "@mokronos/integrations-gateway-api"
export * from "@mokronos/integrations-gateway-core"

const bundledWebDirectory = path.join(import.meta.dirname, "web")

export const serveGateway = (options: ServeOptions): Promise<RunningGateway> =>
  serveGatewayApi({
    ...options,
    webDirectory:
      options.webDirectory ??
      process.env["INTEGRATIONS_WEB_DIR"] ??
      bundledWebDirectory
  })
