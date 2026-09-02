import type { GatewayClient } from "@mokronos/integrations-client"
import { Effect } from "effect"
import { approvalCommand, approvalsCommand, approveCommand, auditCommand, denyCommand, driftCommand, maintenanceCommand } from "./commands/approvals-audit.ts"
import { discoverCommand, integrationsCommand, renameCommand, schemaCommand, searchCommand, toolsCommand } from "./commands/catalog.ts"
import { connectCommand, connectionsCommand, disconnectCommand } from "./commands/connections.ts"
import {
  accessProfileCommand,
  accessProfilesCommand,
  accessProfileToolCommand,
  approvalPoliciesCommand,
  approvalPolicyCommand,
  approvalPolicyToolCommand,
  assignAccessProfileCommand,
  assignApprovalPolicyCommand,
  clientCommand,
  clientsCommand,
  cloneAccessProfileCommand,
  cloneApprovalPolicyCommand,
  keyCommand,
  keysCommand,
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
  renameCommand(gatewayTask),
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
  clientsCommand,
  clientCommand,
  keyCommand,
  keysCommand,
  accessProfilesCommand,
  accessProfileCommand,
  cloneAccessProfileCommand,
  accessProfileToolCommand,
  assignAccessProfileCommand,
  approvalPoliciesCommand,
  approvalPolicyCommand,
  cloneApprovalPolicyCommand,
  approvalPolicyToolCommand,
  assignApprovalPolicyCommand,
  revokeCommand,
  approvalsCommand,
  approveCommand,
  denyCommand,
  auditCommand,
  driftCommand,
  maintenanceCommand
] as const
