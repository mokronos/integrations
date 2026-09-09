import { whenPresent } from "@mokronos/contracts"
import { Crypto, Effect, Schema } from "effect"
import type { HttpClient } from "effect/unstable/http"
import type { IntegrationHost } from "@mokronos/integrations"
import { ToolAddress } from "@mokronos/contracts"
import { authorizeInvocation } from "./authorize.ts"
import { defaultApprovalExpiryHours, defaultArgumentRetentionDays } from "./config.ts"
import {
  aliasForConnection,
  defaultTenantId,
  describeAuthorization,
  sameConnectionRef
} from "./domain.ts"
import type {
  Alias,
  ApprovalId,
  Authorization,
  ConnectionRef,
  PolicyDecision,
  ToolName
} from "./domain.ts"
import { newApprovalId, newAuditId } from "./keys.ts"
import type { GatewayStore, GatewayStoreError, RecordAuditInput } from "./store.ts"

type Json = typeof Schema.Json.Type

export const boundToolAddress = (connection: ConnectionRef, tool: ToolName): ToolAddress =>
  ToolAddress.make(
    `tools.${connection.integration}.${connection.owner}.${connection.name}.${tool}`
  )

export type InvocationOutcome =
  | { readonly status: "succeeded"; readonly result: Json }
  | {
    readonly status: "pending"
    readonly approvalId: ApprovalId
    readonly expiresAt: Date
    readonly approvalUrl?: string
  }
  | { readonly status: "denied"; readonly reason: string }
  | { readonly status: "failed"; readonly message: string }

export interface InvokeDependencies {
  readonly store: GatewayStore
  readonly host: IntegrationHost["Service"]
  readonly argumentRetentionDays?: number
  readonly approvalExpiryHours?: number
  readonly approvalUrlOf?: (approvalId: ApprovalId) => string | undefined
  readonly onApprovalCreated?: (input: {
    readonly authorization: Extract<Authorization, { status: "authorized" }>
    readonly approvalId: ApprovalId
    readonly expiresAt: Date
    readonly approvalUrl?: string
  }) => Effect.Effect<void, never, HttpClient.HttpClient>
}

const auditFor = (
  authorization: Extract<Authorization, { status: "authorized" }>,
  outcome: RecordAuditInput["outcome"],
  message: string | null,
  argumentsValue: Json,
  retentionDays: number
): Effect.Effect<RecordAuditInput, never, Crypto.Crypto> =>
  Effect.map(newAuditId, (id): RecordAuditInput => ({
  tenantId: authorization.client.tenantId,
  id,
  clientId: authorization.client.id,
  alias: authorization.alias,
  tool: authorization.accessProfileTool.tool,
  connection: authorization.connection,
  decision: authorization.decision,
  outcome,
  message,
  arguments: {
    value: argumentsValue,
    expiresAt: new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000)
  }
}))

const freezeOrCollect = Effect.fn("Invocation.freezeOrCollect")(function*(
  dependencies: {
    readonly store: GatewayStore
    readonly retentionDays: number
    readonly expiryHours: number
    readonly approvalUrlOf?: InvokeDependencies["approvalUrlOf"]
    readonly onApprovalCreated?: InvokeDependencies["onApprovalCreated"]
  },
  authorization: Extract<Authorization, { status: "authorized" }>,
  argumentsValue: Json
): Effect.fn.Return<InvocationOutcome, GatewayStoreError, Crypto.Crypto | HttpClient.HttpClient> {
  const { store, retentionDays } = dependencies
  const pending = (approvalId: ApprovalId, expiresAt: Date): InvocationOutcome => {
    const approvalUrl = authorization.client.approvalDelivery.returnLink
      ? dependencies.approvalUrlOf?.(approvalId)
      : undefined
    return {
      status: "pending",
      approvalId,
      expiresAt,
      ...whenPresent("approvalUrl", approvalUrl)
    }
  }
  const existing = yield* store.findUncollectedApproval({
    tenantId: authorization.client.tenantId,
    clientId: authorization.client.id,
    alias: authorization.alias,
    approvalPolicyId: authorization.approvalPolicy.id,
    accessProfileId: authorization.accessProfile.id,
    tool: authorization.accessProfileTool.tool,
    arguments: argumentsValue
  })

  if (existing !== undefined && (existing.status === "pending" || existing.status === "executing")) {
    return pending(existing.id, existing.expiresAt)
  }

  if (
    existing !== undefined
    && (yield* store.collectApproval(authorization.client.tenantId, existing.id))
  ) {
    if (existing.status === "approved") {
      yield* store.recordAudit(yield* auditFor(
        authorization,
        existing.error === null ? "succeeded" : "failed",
        `approval ${existing.id} collected`,
        argumentsValue,
        retentionDays
      ))
      return existing.error === null
        ? { status: "succeeded", result: existing.result }
        : { status: "failed", message: existing.error }
    }
    const reason = existing.status === "expired"
      ? `approval ${existing.id} expired before a decision was recorded`
      : `approval ${existing.id} was denied${existing.decidedBy === null ? "" : ` by ${existing.decidedBy}`
      }`
    yield* store.recordAudit(
      yield* auditFor(authorization, "denied", reason, argumentsValue, retentionDays)
    )
    return { status: "denied", reason }
  }

  const id = (yield* newApprovalId)
  const approval = yield* store.createApproval({
    id,
    tenantId: authorization.client.tenantId,
    clientId: authorization.client.id,
    approvalPolicyId: authorization.approvalPolicy.id,
    accessProfileId: authorization.accessProfile.id,
    alias: authorization.alias,
    tool: authorization.accessProfileTool.tool,
    arguments: argumentsValue,
    expiresAt: new Date(Date.now() + dependencies.expiryHours * 60 * 60 * 1000)
  })
  if (approval.id !== id) return pending(approval.id, approval.expiresAt)
  yield* store.recordAudit(
    yield* auditFor(authorization, "pending", `approval ${approval.id}`, argumentsValue, retentionDays)
  )
  const outcome = pending(approval.id, approval.expiresAt)
  if (dependencies.onApprovalCreated !== undefined) {
    yield* dependencies.onApprovalCreated({
      authorization,
      approvalId: approval.id,
      expiresAt: approval.expiresAt,
      ...whenPresent(
        "approvalUrl",
        outcome.status === "pending" ? outcome.approvalUrl : undefined
      )
    })
  }
  return outcome
})

export const invokeThroughGateway = Effect.fn("Invocation.invokeThroughGateway")(function*(
  dependencies: InvokeDependencies,
  input: {
    readonly secret: string
    readonly alias: Alias
    readonly tool: ToolName
    readonly arguments: Json
  }
): Effect.fn.Return<InvocationOutcome, GatewayStoreError, Crypto.Crypto | HttpClient.HttpClient> {
  const { store, host } = dependencies
  const retentionDays = dependencies.argumentRetentionDays ?? defaultArgumentRetentionDays
  const expiryHours = dependencies.approvalExpiryHours ?? defaultApprovalExpiryHours

  const authorization = yield* authorizeInvocation(store, {
    secret: input.secret,
    alias: input.alias,
    tool: input.tool
  })

  if (authorization.status !== "authorized") {
    yield* store.recordAudit({
      tenantId: defaultTenantId,
      id: (yield* newAuditId),
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

  if (authorization.decision === "require_approval") {
    return yield* freezeOrCollect(
      {
        store,
        retentionDays,
        expiryHours,
        ...whenPresent("approvalUrlOf", dependencies.approvalUrlOf),
        ...whenPresent("onApprovalCreated", dependencies.onApprovalCreated)
      },
      authorization,
      input.arguments
    )
  }

  return yield* executeAuthorized(
    { store, host, retentionDays },
    authorization,
    input.arguments
  )
})

export const executeAuthorized = Effect.fn("Invocation.executeAuthorized")(function*(
  dependencies: {
    readonly store: GatewayStore
    readonly host: IntegrationHost["Service"]
    readonly retentionDays: number
  },
  authorization: Extract<Authorization, { status: "authorized" }>,
  argumentsValue: Json
): Effect.fn.Return<
  Extract<InvocationOutcome, { status: "succeeded" | "failed" }>,
  GatewayStoreError,
  Crypto.Crypto
> {
  const address = boundToolAddress(authorization.connection, authorization.accessProfileTool.tool)
  const invocation = yield* Effect.result(dependencies.host.execute(address, argumentsValue))
  if (invocation._tag === "Success") {
    yield* dependencies.store.recordAudit(
      yield* auditFor(authorization, "succeeded", null, argumentsValue, dependencies.retentionDays)
    )
    return { status: "succeeded", result: invocation.success }
  }
  const message = invocation.failure.message
  yield* dependencies.store.recordAudit(
    yield* auditFor(authorization, "failed", message, argumentsValue, dependencies.retentionDays)
  )
  return { status: "failed", message }
})

export type EffectiveTool = {
  readonly alias: Alias
  readonly tool: ToolName
  readonly connection: ConnectionRef
  readonly decision: PolicyDecision
  readonly description?: string
  readonly inputSchema?: Json
  readonly outputSchema?: Json
}

export const listEffectiveTools = Effect.fn("Invocation.listEffectiveTools")(function*(
  store: GatewayStore,
  clientId: Parameters<GatewayStore["findAccessProfileForClient"]>[0],
  options: {
    readonly schemas?: boolean
    readonly host?: IntegrationHost["Service"]
  } = {}
): Effect.fn.Return<ReadonlyArray<EffectiveTool>, GatewayStoreError> {
  const [accessProfile, approvalPolicy] = yield* Effect.all([
    store.findAccessProfileForClient(clientId),
    store.findApprovalPolicyForClient(clientId)
  ])
  const profileTools = accessProfile === undefined
    ? []
    : yield* store.listAccessProfileTools(accessProfile.id)
  const policyTools = approvalPolicy === undefined
    ? []
    : yield* store.listApprovalPolicyTools(approvalPolicy.id)
  const reachable = profileTools.flatMap((profileTool) =>
    policyTools
      .filter((policyTool) =>
        policyTool.tool === profileTool.tool
        && sameConnectionRef(policyTool.connection, profileTool.connection))
      .map((policyTool) => ({ profileTool, policyTool })))
  const base = reachable.map(({ profileTool, policyTool }) => ({
    alias: aliasForConnection(profileTool.connection),
    tool: profileTool.tool,
    connection: profileTool.connection,
    decision: policyTool.decision
  }))
  if (options.schemas !== true || options.host === undefined) return base

  const host = options.host
  return yield* Effect.forEach(base, (entry) => {
    return host.describeTool(boundToolAddress(entry.connection, entry.tool)).pipe(
      Effect.map((described) => ({
        ...entry,
        ...whenPresent("description", described.description),
        ...whenPresent("inputSchema", described.inputSchema),
        ...whenPresent("outputSchema", described.outputSchema)
      })),
      Effect.catch((failure) =>
        Effect.as(
          Effect.logWarning(
            `No schema for ${entry.alias}.${entry.tool}: ${failure.message}`
          ).pipe(Effect.annotateLogs({
            alias: entry.alias,
            tool: entry.tool,
            operation: "listEffectiveTools.describe"
          })),
          entry
        ))
    )
  }, { concurrency: "unbounded" })
})
