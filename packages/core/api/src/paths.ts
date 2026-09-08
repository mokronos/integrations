import path from "node:path"
import { integrationsHome } from "@mokronos/integrations-client"

export { integrationsHome }

export const gatewayDatabasePath = (home: string): string =>
  path.join(home, "gateway.sqlite")
