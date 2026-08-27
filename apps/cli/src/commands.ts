import type { GatewayClient } from "@mokronos/integrations-client"
import { Effect } from "effect"
import { approvalCommand, approvalsCommand, approveCommand, auditCommand, denyCommand, driftCommand, maintenanceCommand } from "./commands/approvals-audit.ts"
import { discoverCommand, integrationsCommand, schemaCommand, searchCommand, toolsCommand } from "./commands/catalog.ts"
import { connectCommand, connectionsCommand, disconnectCommand } from "./commands/connections.ts"
import { clientCodegenCommand, clientCommand, clientsCommand, grantCommand, keyCommand, keysCommand, operatorCodegenCommand, operatorGrantsCommand, ownGrantsCommand, revokeCommand } from "./commands/delegation.ts"
import { clientExecuteCommand, operatorExecuteCommand, validateCommand } from "./commands/invocation.ts"
import type { IntegrationsCliError } from "./connection.ts"
import {
  cliError,
  connectToGateway,
  describeError
} from "./connection.ts"
import { connectToOperatorGateway } from "./session.ts"

const gatewayTask = <A>(
  task: (client: GatewayClient) => Promise<A>
): Effect.Effect<A, IntegrationsCliError> =>
  Effect.tryPromise({
    try: async () => await task(await connectToGateway()),
    catch: (error) => cliError(describeError(error))
  })

const operatorGatewayTask = <A>(
  task: (client: GatewayClient) => Promise<A>
): Effect.Effect<A, IntegrationsCliError> =>
  Effect.tryPromise({
    try: async () => await task(await connectToOperatorGateway()),
    catch: (error) => cliError(describeError(error))
  })

export const clientSubcommands = [
  discoverCommand(gatewayTask),
  searchCommand(gatewayTask),
  integrationsCommand(gatewayTask),
  toolsCommand(gatewayTask),
  schemaCommand(gatewayTask),
  connectCommand(gatewayTask),
  connectionsCommand(gatewayTask),
  disconnectCommand(gatewayTask),
  clientExecuteCommand,
  validateCommand(gatewayTask),
  approvalCommand,
  ownGrantsCommand,
  clientCodegenCommand
] as const

export const operatorClientSubcommands = [
  discoverCommand(operatorGatewayTask),
  searchCommand(operatorGatewayTask),
  integrationsCommand(operatorGatewayTask),
  toolsCommand(operatorGatewayTask),
  schemaCommand(operatorGatewayTask),
  connectCommand(operatorGatewayTask),
  connectionsCommand(operatorGatewayTask),
  disconnectCommand(operatorGatewayTask),
  operatorExecuteCommand,
  validateCommand(operatorGatewayTask),
  approvalCommand,
  operatorCodegenCommand
] as const

export const controlPlaneSubcommands = [
  clientsCommand,
  clientCommand,
  keyCommand,
  keysCommand,
  grantCommand,
  operatorGrantsCommand,
  revokeCommand,
  approvalsCommand,
  approveCommand,
  denyCommand,
  auditCommand,
  driftCommand,
  maintenanceCommand
] as const
