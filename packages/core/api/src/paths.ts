import path from "node:path"
import { integrationsHome } from "@integrations/contracts/gateway-config"

export { integrationsHome }

export const gatewayDatabasePath = (home: string): string =>
  path.join(home, "gateway.sqlite")
