import path from "node:path"
import { integrationsHome, traceFilePath } from "@integragents/contracts/gateway-config"

export { integrationsHome, traceFilePath }

export const gatewayDatabasePath = (home: string): string =>
  path.join(home, "gateway.sqlite")
