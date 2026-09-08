export type { ClientConnection } from "@mokronos/integrations-client"
export {
  defaultGatewayPort,
  GatewayConfigFile,
  gatewayConfigPath,
  readGatewayConfig,
  resolveClientConnection,
  writeGatewayConfig
} from "@mokronos/integrations-client"

export const defaultArgumentRetentionDays = 30

export const defaultApprovalExpiryHours = 24
