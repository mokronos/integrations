import { Schema } from "effect"
import type { ExecutorServices } from "@mokronos/wfkit-executor"
import { ExecutorToolAddress } from "@mokronos/wfkit-executor/schemas"
import { authorizeInvocation } from "./authorize.ts"
import { defaultApprovalExpiryHours, defaultArgumentRetentionDays } from "./config.ts"
import { describeAuthorization } from "./domain.ts"
import type {
  Alias,
  ApprovalId,
  Authorization,
  ConnectionRef,
  Grant,
  ToolName
} from "./domain.ts"
import { newApprovalId, newAuditId } from "./keys.ts"
import type { GatewayStore, RecordAuditInput } from "./store.ts"

type Json = typeof Schema.Json.Type

/** The address is built from the grant, never accepted from the caller. That is
 * what makes invocation-by-address safe to expose: a caller naming an address
 * directly still has to hold a grant that produces it. */
export const grantToolAddress = (connection: ConnectionRef, tool: ToolName): ExecutorToolAddress =>
  ExecutorToolAddress.make(
    `tools.${connection.integration}.${connection.owner}.${connection.name}.${tool}`
  )

export type InvocationOutcome =
  | { readonly status: "succeeded"; readonly result: Json }
  | { readonly status: "pending"; readonly approvalId: ApprovalId; readonly expiresAt: Date }
  | { readonly status: "denied"; readonly reason: string }
  | { readonly status: "failed"; readonly message: string }

export interface InvokeDependencies {
  readonly store: GatewayStore
  readonly executor: Pick<ExecutorServices, "tools">
  readonly argumentRetentionDays?: number
  readonly approvalExpiryHours?: number
}

const auditFor = (
  authorization: Extract<Authorization, { status: "authorized" }>,
  outcome: RecordAuditInput["outcome"],
  message: string | null,
  argumentsValue: Json,
  retentionDays: number
): RecordAuditInput => ({
  id: newAuditId(),
  clientId: authorization.client.id,
  alias: authorization.grant.alias,
  tool: authorization.grant.tool,
  connection: authorization.connection,
  decision: authorization.grant.decision,
  outcome,
  message,
  arguments: {
    value: argumentsValue,
    expiresAt: new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000)
  }
})

/** Performs one delegated invocation: authorize, then either execute with
 * injected credentials or freeze the call for a human.
 *
 * Every branch writes an audit record, including the denials that never reached
 * a connection — an audit trail with holes where the refusals were is not much
 * of an audit trail. */
export const invokeThroughGateway = async (
  dependencies: InvokeDependencies,
  input: {
    readonly secret: string
    readonly alias: Alias
    readonly tool: ToolName
    readonly arguments: Json
  }
): Promise<InvocationOutcome> => {
  const { store, executor } = dependencies
  const retentionDays = dependencies.argumentRetentionDays ?? defaultArgumentRetentionDays
  const expiryHours = dependencies.approvalExpiryHours ?? defaultApprovalExpiryHours

  const authorization = await authorizeInvocation(store, {
    secret: input.secret,
    alias: input.alias,
    tool: input.tool
  })

  if (authorization.status !== "authorized") {
    // No client id: an unknown key names nobody. The reason is still recorded.
    await store.recordAudit({
      id: newAuditId(),
      clientId: null,
      alias: input.alias,
      tool: input.tool,
      connection: null,
      decision: null,
      outcome: "denied",
      message: describeAuthorization(authorization)
    })
    return { status: "denied", reason: describeAuthorization(authorization) }
  }

  if (authorization.grant.decision === "require_approval") {
    const approval = await store.createApproval({
      id: newApprovalId(),
      clientId: authorization.client.id,
      grantId: authorization.grant.id,
      alias: authorization.grant.alias,
      tool: authorization.grant.tool,
      arguments: input.arguments,
      expiresAt: new Date(Date.now() + expiryHours * 60 * 60 * 1000)
    })
    await store.recordAudit(
      auditFor(authorization, "pending", `approval ${approval.id}`, input.arguments, retentionDays)
    )
    return { status: "pending", approvalId: approval.id, expiresAt: approval.expiresAt }
  }

  return await executeAuthorized(
    { store, executor, retentionDays },
    authorization,
    input.arguments
  )
}

/** Runs a call that has already cleared policy. Shared by the allow path and by
 * approval settlement, so an approved invocation is performed by the gateway on
 * exactly the same code path — the caller never gains the capability itself. */
export const executeAuthorized = async (
  dependencies: {
    readonly store: GatewayStore
    readonly executor: Pick<ExecutorServices, "tools">
    readonly retentionDays: number
  },
  authorization: Extract<Authorization, { status: "authorized" }>,
  argumentsValue: Json
): Promise<InvocationOutcome> => {
  const address = grantToolAddress(authorization.connection, authorization.grant.tool)
  try {
    const result = await dependencies.executor.tools.execute(address, argumentsValue)
    await dependencies.store.recordAudit(
      auditFor(authorization, "succeeded", null, argumentsValue, dependencies.retentionDays)
    )
    return { status: "succeeded", result }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Integration call failed"
    await dependencies.store.recordAudit(
      auditFor(authorization, "failed", message, argumentsValue, dependencies.retentionDays)
    )
    return { status: "failed", message }
  }
}

/** The tools a client may actually reach. Discovery is grant-scoped, which is
 * why there is no `block` decision: an ungranted tool is invisible rather than
 * visible-then-failing. */
export const listGrantedTools = async (
  store: GatewayStore,
  grantsOwner: Parameters<GatewayStore["listGrants"]>[0]
): Promise<ReadonlyArray<{
  readonly alias: Alias
  readonly tool: ToolName
  readonly integration: string
  readonly decision: Grant["decision"]
}>> =>
  (await store.listGrants(grantsOwner)).map((grant) => ({
    alias: grant.alias,
    tool: grant.tool,
    integration: grant.connection.integration,
    decision: grant.decision
  }))
