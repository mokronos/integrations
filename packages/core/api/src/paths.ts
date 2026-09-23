import path from "node:path"
import { integrationsHome, traceFilePath } from "@mokronos/integrations-contracts/gateway-config"

export { integrationsHome, traceFilePath }

export const gatewayDatabasePath = (home: string): string =>
  path.join(home, "gateway.sqlite")
