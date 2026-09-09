export type { ClientConnection } from "@mokronos/contracts/gateway-config"
export {
  defaultGatewayPort,
  GatewayConfigFile,
  gatewayConfigPath,
  readGatewayConfig,
  resolveClientConnection,
  writeGatewayConfig
} from "@mokronos/contracts/gateway-config"

export const defaultArgumentRetentionDays = 30

export const defaultApprovalExpiryHours = 24
