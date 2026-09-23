export type { ClientConnection } from "@integragents/contracts/gateway-config"
export {
  defaultGatewayPort,
  GatewayConfigFile,
  gatewayConfigPath,
  operatorGatewayConfigPath,
  readGatewayConfig,
  readOperatorGatewayConfig,
  resolveClientConnection,
  resolveOperatorConnection,
  writeGatewayConfig,
  writeOperatorGatewayConfig
} from "@integragents/contracts/gateway-config"

export const defaultArgumentRetentionDays = 30

export const defaultApprovalExpiryHours = 24
