/** Finding the gateway is a client concern, so the config file's shape, path,
 * and resolution live in the client package. The gateway re-exports them and
 * adds only the values a server needs. */
export type { ClientConnection } from "@mokronos/integrations-client"
export {
  defaultGatewayPort,
  GatewayConfigFile,
  gatewayConfigPath,
  readGatewayConfig,
  resolveClientConnection,
  writeGatewayConfig
} from "@mokronos/integrations-client"

/** How long invocation arguments are kept in the audit trail. The record they
 *  hang off is permanent; these are where the PII lives and their forensic
 *  value decays within days, so they age out separately. */
export const defaultArgumentRetentionDays = 30

/** How long a frozen invocation waits for a human before it is a decision. */
export const defaultApprovalExpiryHours = 24
