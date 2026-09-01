import path from "node:path"
import { integrationsHome } from "@mokronos/integrations-client"

export { integrationsHome }

/** Clients, API keys, access profiles, approval policies, approvals, and audit records. Separate from
 * the host's database because resolving a binding is what determines the subject
 * a host instance must be bound to — so it has to be readable first. */
export const gatewayDatabasePath = (home: string): string =>
  path.join(home, "gateway.sqlite")
