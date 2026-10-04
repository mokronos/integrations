import type { GatewayClient } from "@integragents/client"
import type { HttpClient } from "effect/http"
import { Effect } from "effect"
import { approvalCommand, approvalsCommand, approveCommand, auditCommand, denyCommand, driftCommand, maintenanceCommand } from "./commands/approvals-audit.ts"
import { discoverCommand, integrationsCommand, renameCommand, schemaCommand, searchCommand, toolsCommand } from "./commands/catalog.ts"
import { connectCommand, connectionsCommand, disconnectCommand } from "./commands/connections.ts"
import {
  keyCommand,
  keysCommand,
  profileCommand,
  profilesCommand,
  profileToolCommand,
  profileToolsCommand,
  revokeCommand
} from "./commands/delegation.ts"
import { clientExecuteCommand, operatorExecuteCommand, validateCommand } from "./commands/invocation.ts"
import type { IntegrationsCliError } from "./connection.ts"
import {
  cliError,
  connectToGateway,
  describeError
} from "./connection.ts"
import { connectToOperatorGateway } from "./session.ts"

const gatewayTask = <A, E, R>(
  task: (client: GatewayClient) => Effect.Effect<A, E, R>
): Effect.Effect<A, IntegrationsCliError, R | HttpClient.HttpClient> =>
  connectToGateway().pipe(
    Effect.flatMap(task),
    Effect.mapError((error) => cliError(describeError(error)))
  )

const operatorGatewayTask = <A, E, R>(
  task: (client: GatewayClient) => Effect.Effect<A, E, R>
): Effect.Effect<A, IntegrationsCliError, R | HttpClient.HttpClient> =>
  connectToOperatorGateway().pipe(
    Effect.flatMap(task),
    Effect.mapError((error) => cliError(describeError(error)))
  )

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
  approvalCommand
] as const

export const operatorClientSubcommands = [
  discoverCommand(operatorGatewayTask),
  searchCommand(operatorGatewayTask),
  integrationsCommand(operatorGatewayTask),
  renameCommand(operatorGatewayTask),
  toolsCommand(operatorGatewayTask),
  schemaCommand(operatorGatewayTask),
  connectCommand(operatorGatewayTask),
  connectionsCommand(operatorGatewayTask),
  disconnectCommand(operatorGatewayTask),
  operatorExecuteCommand,
  validateCommand(operatorGatewayTask),
  approvalCommand
] as const

export const controlPlaneSubcommands = [
  profilesCommand,
  profileCommand,
  profileToolsCommand,
  profileToolCommand,
  keyCommand,
  keysCommand,
  revokeCommand,
  approvalsCommand,
  approveCommand,
  denyCommand,
  auditCommand,
  driftCommand,
  maintenanceCommand
] as const
