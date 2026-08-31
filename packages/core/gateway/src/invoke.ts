import { whenPresent } from "@mokronos/contracts"
import { Effect, Schema } from "effect"
import type { IntegrationsApi } from "@mokronos/integrations"
import { ToolAddress } from "@mokronos/contracts"
import { authorizeInvocation } from "./authorize.ts"
import { defaultApprovalExpiryHours, defaultArgumentRetentionDays } from "./config.ts"
import { defaultTenantId, describeAuthorization, sameConnectionRef } from "./domain.ts"
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

class IntegrationCallError extends Schema.TaggedError<IntegrationCallError>()(
  "IntegrationCallError",
  {
    message: Schema.String,
    cause: Schema.Defect()
  }
) {}

/** The address is built from the grant, never accepted from the caller. That is
 * what makes invocation-by-address safe to expose: a caller naming an address
 * directly still has to hold a grant and a policy rule that produce it. */
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
  readonly integrations: Pick<IntegrationsApi, "tools">
  readonly argumentRetentionDays?: number
  readonly approvalExpiryHours?: number
  readonly approvalUrlOf?: (approvalId: ApprovalId) => string | undefined
  readonly onApprovalCreated?: (input: {
    readonly authorization: Extract<Authorization, { status: "authorized" }>
    readonly approvalId: ApprovalId
    readonly expiresAt: Date
    readonly approvalUrl?: string
  }) => Effect.Effect<void>
}

const auditFor = (
  authorization: Extract<Authorization, { status: "authorized" }>,
  outcome: RecordAuditInput["outcome"],
  message: string | null,
  argumentsValue: Json,
  retentionDays: number
): RecordAuditInput => ({
  // The trail belongs to the client's partition, not to whoever happens to be
  // asking: a tenant reads its own history and nothing else's.
  tenantId: authorization.client.tenantId,
  id: newAuditId(),
  clientId: authorization.client.id,
  alias: authorization.grant.alias,
  tool: authorization.policyTool.tool,
  connection: authorization.connection,
  decision: authorization.decision,
  outcome,
  message,
  arguments: {
    value: argumentsValue,
    expiresAt: new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000)
  }
})

/** The approval half of an invocation: meet the frozen call this request
 * already belongs to, or freeze a new one.
 *
 * A caller that retries — and the retrying caller is the normal case, because a
 * durable step is how a workflow waits — must not ask a human again for a
 * decision it already asked for. The same (policy, grant, tool, arguments) resolves to the
 * same approval until that approval's outcome has been handed back exactly
 * once. After delivery an identical call is a *new* request, and needs its own
 * decision; replaying an old approval forever would turn one "yes" into
 * standing permission, which this design deliberately refuses to create. */
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
): Effect.fn.Return<InvocationOutcome, GatewayStoreError> {
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
  const existing = yield* store.findUncollectedApproval(
    authorization.policy.id,
    authorization.grant.id,
    authorization.policyTool.tool,
    argumentsValue
  )

  if (existing !== undefined && existing.status === "pending") {
    // Deliberately not audited: the frozen call was recorded when it was
    // proposed, and one decision pending is one event, however many times a
    // retry loop looks at it.
    return pending(existing.id, existing.expiresAt)
  }

  if (
    existing !== undefined
    && (yield* store.collectApproval(authorization.client.tenantId, existing.id))
  ) {
    if (existing.status === "approved") {
      // The gateway already performed this call, at approval time. What is
      // being handed back is that call's result, not a second call.
      yield* store.recordAudit(auditFor(
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
      auditFor(authorization, "denied", reason, argumentsValue, retentionDays)
    )
    return { status: "denied", reason }
  }

  const approval = yield* store.createApproval({
    id: newApprovalId(),
    tenantId: authorization.client.tenantId,
    clientId: authorization.client.id,
    policyId: authorization.policy.id,
    grantId: authorization.grant.id,
    alias: authorization.grant.alias,
    tool: authorization.policyTool.tool,
    arguments: argumentsValue,
    expiresAt: new Date(Date.now() + dependencies.expiryHours * 60 * 60 * 1000)
  })
  yield* store.recordAudit(
    auditFor(authorization, "pending", `approval ${approval.id}`, argumentsValue, retentionDays)
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

/** Performs one delegated invocation: authorize, then either execute with
 * injected credentials or freeze the call for a human.
 *
 * Every branch writes an audit record, including the denials that never reached
 * a connection — an audit trail with holes where the refusals were is not much
 * of an audit trail. */
export const invokeThroughGateway = Effect.fn("Invocation.invokeThroughGateway")(function*(
  dependencies: InvokeDependencies,
  input: {
    readonly secret: string
    readonly alias: Alias
    readonly tool: ToolName
    readonly arguments: Json
  }
): Effect.fn.Return<InvocationOutcome, GatewayStoreError> {
  const { store, integrations } = dependencies
  const retentionDays = dependencies.argumentRetentionDays ?? defaultArgumentRetentionDays
  const expiryHours = dependencies.approvalExpiryHours ?? defaultApprovalExpiryHours

  const authorization = yield* authorizeInvocation(store, {
    secret: input.secret,
    alias: input.alias,
    tool: input.tool
  })

  if (authorization.status !== "authorized") {
    // No client id: an unknown key names nobody. The reason is still recorded,
    // under the default tenant — there is nothing else an unauthenticated call
    // could be filed under.
    yield* store.recordAudit({
      tenantId: defaultTenantId,
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
    { store, integrations, retentionDays },
    authorization,
    input.arguments
  )
})

/** Runs a call that has already cleared policy. Shared by the allow path and by
 * approval settlement, so an approved invocation is performed by the gateway on
 * exactly the same code path — the caller never gains the capability itself. */
export const executeAuthorized = Effect.fn("Invocation.executeAuthorized")(function*(
  dependencies: {
    readonly store: GatewayStore
    readonly integrations: Pick<IntegrationsApi, "tools">
    readonly retentionDays: number
  },
  authorization: Extract<Authorization, { status: "authorized" }>,
  argumentsValue: Json
): Effect.fn.Return<InvocationOutcome, GatewayStoreError> {
  const address = boundToolAddress(authorization.connection, authorization.policyTool.tool)
  const invocation = yield* Effect.result(Effect.tryPromise({
    try: () => dependencies.integrations.tools.execute(address, argumentsValue),
    catch: (cause) => new IntegrationCallError({
      message: cause instanceof Error ? cause.message : "Integration call failed",
      cause
    })
  }))
  if (invocation._tag === "Success") {
    yield* dependencies.store.recordAudit(
      auditFor(authorization, "succeeded", null, argumentsValue, dependencies.retentionDays)
    )
    return { status: "succeeded", result: invocation.success }
  }
  const message = invocation.failure.message
  yield* dependencies.store.recordAudit(
    auditFor(authorization, "failed", message, argumentsValue, dependencies.retentionDays)
  )
  return { status: "failed", message }
})

export type EffectiveTool = {
  readonly alias: Alias
  readonly tool: ToolName
  readonly integration: string
  /** The connection the alias resolves to. Two aliases can carry the same
   * vendor tool against different credentials, so the name is part of the
   * answer rather than an implementation detail. */
  readonly connection: string
  readonly decision: PolicyDecision
  readonly inputSchema?: Json
  readonly outputSchema?: Json
}

/** The tools a client may actually reach: the cross product of the connections
 * it holds grants for and the rules its policy enables on them. Discovery uses
 * the same intersection invocation does, so an unauthorized tool is invisible
 * rather than visible-then-failing.
 *
 * A rule naming a connection this client was never granted contributes nothing
 * here, and is not an error — that is exactly how one policy serves several
 * clients holding different subsets of the tenant's credentials.
 *
 * Schemas are opt-in because fetching them costs one catalog read per tool.
 * With them, this listing is exactly what codegen emits — so the generated
 * surface and the authorized surface cannot drift apart. */
export const listEffectiveTools = Effect.fn("Invocation.listEffectiveTools")(function*(
  store: GatewayStore,
  clientId: Parameters<GatewayStore["listGrants"]>[0],
  options: {
    readonly schemas?: boolean
    readonly integrations?: Pick<IntegrationsApi, "tools">
  } = {}
): Effect.fn.Return<ReadonlyArray<EffectiveTool>, GatewayStoreError> {
  const grants = yield* store.listGrants(clientId)
  const policy = yield* store.findPolicyForClient(clientId)
  const rules = policy === undefined ? [] : yield* store.listPolicyTools(policy.id)
  const reachable = grants.flatMap((grant) =>
    rules
      .filter((rule) => rule.enabled && sameConnectionRef(rule.connection, grant.connection))
      .map((rule) => ({ grant, rule })))
  const base = reachable.map(({ grant, rule }) => ({
    alias: grant.alias,
    tool: rule.tool,
    integration: grant.connection.integration,
    connection: grant.connection.name,
    decision: rule.decision
  }))
  if (options.schemas !== true || options.integrations === undefined) return base

  const integrations = options.integrations
  return yield* Effect.forEach(base, (entry, index) => {
    const route = reachable[index]
    if (route === undefined) return Effect.succeed(entry)
    return Effect.tryPromise(() => integrations.tools.describe(
      boundToolAddress(route.grant.connection, route.rule.tool)
    )).pipe(
      Effect.map((described) => ({
        ...entry,
        ...whenPresent("inputSchema", described.inputSchema),
        ...whenPresent("outputSchema", described.outputSchema)
      })),
      Effect.orElseSucceed(() => entry)
    )
  }, { concurrency: "unbounded" })
})
