export type { ClientConnection } from "@integrations/contracts/gateway-config"
export {
  defaultGatewayPort,
  GatewayConfigFile,
  gatewayConfigPath,
  readGatewayConfig,
  resolveClientConnection,
  writeGatewayConfig
} from "@integrations/contracts/gateway-config"

export const defaultArgumentRetentionDays = 30

export const defaultApprovalExpiryHours = 24
