import { connectionOwner, connectionRefOf, isDelegationTemplate, whenPresent } from "@integrations/contracts"
import type { InvocationOutcome } from "@integrations/contracts"
import { Crypto, DateTime, Duration, Effect, Option, Schema } from "effect"
import type { HttpClient } from "effect/unstable/http"
import type { Integrations } from "@integrations/integrations"
import { ToolAddress } from "@integrations/contracts"
import type { OAuthSessions } from "./oauth-sessions.ts"
import { invalidArguments } from "./arguments.ts"
import { authorizeClientInvocation, authorizeInvocation } from "./authorize.ts"
import { defaultApprovalExpiryHours, defaultArgumentRetentionDays } from "./config.ts"
import {
  aliasForConnection,
  defaultTenantId,
  sameConnectionRef
} from "./domain.ts"
import type {
  Alias,
  ApprovalId,
  Authorized,
  Client,
  ConnectionName,
  Authorization,
  ConnectionRef,
  IntegrationSlug,
  PolicyDecision,
  SubjectId,
  TenantId,
  ToolName
} from "./domain.ts"
import { newApprovalId, newAuditId } from "./keys.ts"
import type { GatewayStore, GatewayStoreError, RecordAuditInput } from "./store.ts"

type Json = typeof Schema.Json.Type

export const boundToolAddress = (connection: ConnectionRef, tool: ToolName): ToolAddress =>
  ToolAddress.make(
    `tools.${connection.integration}.${connectionOwner(connection)}.${connection.name}.${tool}`
  )

export interface InvokeDependencies {
  readonly store: GatewayStore
  readonly integrations: Integrations["Service"]
  /** Starts the flow a delegated tool needs when its user has not connected yet. */
  readonly oauth?: OAuthSessions
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
  Effect.all([newAuditId, DateTime.now]).pipe(Effect.map(([id, at]): RecordAuditInput => ({
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
    expiresAt: DateTime.toDateUtc(DateTime.addDuration(at, Duration.days(retentionDays)))
  }
})))

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
    expiresAt: DateTime.toDateUtc(
      DateTime.addDuration(yield* DateTime.now, Duration.hours(dependencies.expiryHours))
    )
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

const settle = Effect.fn("Invocation.settle")(function*(
  dependencies: InvokeDependencies,
  tenantId: TenantId,
  authorization: Authorization,
  input: {
    readonly alias: Alias
    readonly tool: ToolName
    readonly arguments: Json
  }
): Effect.fn.Return<InvocationOutcome, GatewayStoreError, Crypto.Crypto | HttpClient.HttpClient> {
  const { store, integrations } = dependencies
  const retentionDays = dependencies.argumentRetentionDays ?? defaultArgumentRetentionDays
  const expiryHours = dependencies.approvalExpiryHours ?? defaultApprovalExpiryHours

  if (authorization.status !== "authorized") {
    const reason = authorization.message
    yield* store.recordAudit({
      tenantId,
      id: (yield* newAuditId),
      clientId: null,
      alias: input.alias,
      tool: input.tool,
      connection: null,
      decision: null,
      outcome: "denied",
      message: reason
    })
    return { status: "denied", reason }
  }

  const invalid = yield* checkArguments(integrations, authorization, input.arguments)
  if (invalid !== undefined) return invalid

  const missing = yield* missingUserConnection(dependencies, authorization)
  if (missing !== undefined) return missing

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

/**
 * Arguments are checked against the tool's declared input schema before any
 * approval is frozen, so a malformed call fails fast for the caller instead of
 * failing at the vendor after a human said yes.
 */
const checkArguments = Effect.fn("Invocation.checkArguments")(function*(
  integrations: Integrations["Service"],
  authorization: Authorized,
  argumentsValue: Json
): Effect.fn.Return<InvocationOutcome | undefined> {
  const address = boundToolAddress(authorization.connection, authorization.accessProfileTool.tool)
  const described = yield* integrations.describeTool(address).pipe(
    Effect.map(Option.some),
    Effect.catch(() => Effect.succeed(Option.none()))
  )
  if (Option.isNone(described)) return undefined
  return invalidArguments(described.value.inputSchema, argumentsValue, authorization.accessProfileTool.tool)
})

/**
 * A delegated tool whose user has no live connection yet cannot run. Instead
 * the OAuth flow starts, bound to that user, and the caller gets what it needs
 * to send the person to their browser and try again afterwards.
 */
const missingUserConnection = Effect.fn("Invocation.missingUserConnection")(function*(
  dependencies: InvokeDependencies,
  authorization: Authorized
): Effect.fn.Return<InvocationOutcome | undefined, GatewayStoreError> {
  const connection = authorization.connection
  if (!isDelegationTemplate(authorization.accessProfileTool.connection)) return undefined
  if (connection.owner !== "user" || connection.subject === undefined) return undefined
  const subject = connection.subject
  const held = yield* dependencies.integrations.listConnections({
    integration: connection.integration,
    owner: connectionOwner(connection)
  }).pipe(Effect.catch(() => Effect.succeed([])))
  const live = held.find((candidate) => candidate.name === connection.name && candidate.status === "connected")
  if (live !== undefined) return undefined

  const deny = (reason: string): InvocationOutcome => ({ status: "denied", reason })
  if (dependencies.oauth === undefined) {
    return deny(`${authorization.alias}.${authorization.accessProfileTool.tool} needs ${subject} to connect ${connection.integration} first`)
  }
  const integration = yield* dependencies.integrations.findIntegration(connection.integration).pipe(
    Effect.catch(() => Effect.succeed(Option.none()))
  )
  const method = Option.isNone(integration)
    ? undefined
    : integration.value.authMethods.find((candidate) => candidate.kind === "oauth")
  if (method === undefined) {
    return deny(`${connection.integration} offers no OAuth method, so it cannot be connected on behalf of ${subject}`)
  }
  const session = yield* dependencies.oauth.start({
    integration: connection.integration,
    connection: connection.name,
    authMethod: method,
    bindingTenant: authorization.client.tenantId,
    subject
  }).pipe(Effect.catch((failure) => Effect.succeed(failure)))
  if ("_tag" in session) {
    return deny(`${connection.integration} could not start authorization for ${subject}: ${session.message}`)
  }
  return {
    status: "authorization-required",
    integration: connection.integration,
    connection: connection.name,
    subject,
    session: { id: session.id, integration: session.integration, connection: session.connection, state: session.state }
  }
})

/** An invocation presented with an API key, as the HTTP route receives it. */
export const invokeThroughGateway = Effect.fn("Invocation.invokeThroughGateway")(function*(
  dependencies: InvokeDependencies,
  input: {
    readonly secret: string
    readonly alias: Alias
    readonly tool: ToolName
    readonly arguments: Json
    readonly subject?: SubjectId
  }
): Effect.fn.Return<InvocationOutcome, GatewayStoreError, Crypto.Crypto | HttpClient.HttpClient> {
  const authorization = yield* authorizeInvocation(dependencies.store, input)
  return yield* settle(dependencies, defaultTenantId, authorization, input)
})

/**
 * An invocation on behalf of a client the host already identified: the same
 * policy, approval, and audit path, with no key to present or check.
 */
export const invokeAsClient = Effect.fn("Invocation.invokeAsClient")(function*(
  dependencies: InvokeDependencies,
  input: {
    readonly client: Client
    readonly alias: Alias
    readonly tool: ToolName
    readonly arguments: Json
    readonly subject?: SubjectId
  }
): Effect.fn.Return<InvocationOutcome, GatewayStoreError, Crypto.Crypto | HttpClient.HttpClient> {
  const authorization = yield* authorizeClientInvocation(dependencies.store, input.client, input)
  return yield* settle(dependencies, input.client.tenantId, authorization, input)
})

export const executeAuthorized = Effect.fn("Invocation.executeAuthorized")(function*(
  dependencies: {
    readonly store: GatewayStore
    readonly integrations: Integrations["Service"]
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
  const invocation = yield* Effect.result(dependencies.integrations.execute(address, argumentsValue))
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
  /** The tool runs on the calling user's own connection; invocations must name a subject. */
  readonly delegated: boolean
  readonly description?: string
  readonly inputSchema?: Json
  readonly outputSchema?: Json
}

export const listEffectiveTools = Effect.fn("Invocation.listEffectiveTools")(function*(
  store: GatewayStore,
  clientId: Parameters<GatewayStore["findAccessProfileForClient"]>[0],
  options: {
    readonly schemas?: boolean
    readonly integrations?: Integrations["Service"]
    readonly integration?: IntegrationSlug
    readonly connection?: ConnectionName
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
  const filtered = profileTools.filter((profileTool) =>
    (options.integration === undefined || profileTool.connection.integration === options.integration)
    && (options.connection === undefined || profileTool.connection.name === options.connection))
  const reachable = yield* Effect.forEach(filtered, (profileTool) => Effect.gen(function*() {
    const policyTool = policyTools.find((candidate) =>
      candidate.tool === profileTool.tool
      && sameConnectionRef(candidate.connection, profileTool.connection))
    if (policyTool === undefined) {
      return yield* Effect.die(new Error(
        `Approval policy ${approvalPolicy?.id ?? "missing"} has no decision for ${aliasForConnection(profileTool.connection)}.${profileTool.tool}`
      ))
    }
    return { profileTool, policyTool }
  }))
  const base = reachable.map(({ profileTool, policyTool }) => ({
    alias: aliasForConnection(profileTool.connection),
    tool: profileTool.tool,
    connection: profileTool.connection,
    decision: policyTool.decision,
    delegated: isDelegationTemplate(profileTool.connection)
  }))
  if (options.schemas !== true || options.integrations === undefined) return base

  const host = options.integrations
  /** A template names no connection of its own; any held connection of the integration describes the tool. */
  const addressOf = (entry: { readonly connection: ConnectionRef; readonly tool: ToolName }) =>
    isDelegationTemplate(entry.connection)
      ? host.listConnections({ integration: entry.connection.integration }).pipe(
        Effect.map((held) => {
          const sample = held[0]
          return sample === undefined
            ? Option.none<ToolAddress>()
            : Option.some(boundToolAddress(connectionRefOf(sample.owner, sample.integration, sample.name), entry.tool))
        }),
        Effect.catch(() => Effect.succeed(Option.none<ToolAddress>()))
      )
      : Effect.succeed(Option.some(boundToolAddress(entry.connection, entry.tool)))
  const describe = (entry: (typeof base)[number], address: ToolAddress) =>
    host.describeTool(address).pipe(
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
  return yield* Effect.forEach(base, (entry) =>
    Effect.flatMap(addressOf(entry), Option.match({
      onNone: () => Effect.succeed(entry),
      onSome: (address) => describe(entry, address)
    })), { concurrency: "unbounded" })
})
