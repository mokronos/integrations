import {
  connectionOwner,
  connectionRefOf,
  isDelegationTemplate,
  matchesPattern,
  whenPresent
} from "@integragents/contracts"
import type { InputAnswer, InputResponses, InvocationOutcome, ToolSummary } from "@integragents/contracts"
import { Crypto, DateTime, Duration, Effect, Option, Schema } from "effect"
import type { HttpClient } from "effect/http"
import { relayableInput, unrelayableInputMessage } from "@integragents/host"
import type { Integrations, ToolCallContext } from "@integragents/host"
import { ToolAddress } from "@integragents/contracts"
import type { OAuthSessions } from "./oauth-sessions.ts"
import { invalidArguments } from "./arguments.ts"
import { authenticateKey, authorizeProfileInvocation } from "./authorize.ts"
import { defaultArgumentRetentionDays } from "./config.ts"
import { aliasForConnection, defaultTenantId, keyOrigin, sameConnectionRef, unattributedOrigin } from "./domain.ts"
import type {
  Alias,
  ApprovalId,
  AuditApproval,
  Authorized,
  CallOrigin,
  ConnectionName,
  Authorization,
  ConnectionRef,
  IntegrationSlug,
  Profile,
  ProfileId,
  SubjectId,
  TenantId,
  ToolDecision,
  ToolName
} from "./domain.ts"
import { openRound, sealRound } from "./input-rounds.ts"
import type { RoundApproval } from "./input-rounds.ts"
import { newApprovalId, newAuditId } from "./keys.ts"
import type { GatewayStore, GatewayStoreError, RecordAuditInput } from "./store.ts"

type Json = typeof Schema.Json.Type

export const boundToolAddress = (connection: ConnectionRef, tool: ToolName): ToolAddress =>
  ToolAddress.make(`tools.${connection.integration}.${connectionOwner(connection)}.${connection.name}.${tool}`)

export interface InvokeDependencies {
  readonly store: GatewayStore
  readonly integrations: Integrations["Service"]
  /** Starts the flow a delegated tool needs when its user has not connected yet. */
  readonly oauth?: OAuthSessions
  readonly argumentRetentionDays?: number
  readonly approvalUrlOf?: (approvalId: ApprovalId) => string | undefined
  readonly onApprovalCreated?: (input: {
    readonly authorization: Extract<Authorization, { status: "authorized" }>
    readonly approvalId: ApprovalId
    readonly expiresAt: Date | null
    readonly approvalUrl?: string
  }) => Effect.Effect<void, never, HttpClient.HttpClient>
}

/**
 * Whether the caller can put a tool's requests for input to a human, and its
 * answers to the round an earlier call ended with. A caller that cannot relay
 * gets a tool error saying what was asked instead.
 */
export interface Interaction {
  readonly relay: boolean
  readonly answer?: { readonly inputResponses: InputResponses; readonly requestState: string }
}

const noInteraction: Interaction = { relay: false }

const auditFor = (
  authorization: Extract<Authorization, { status: "authorized" }>,
  outcome: RecordAuditInput["outcome"],
  message: string | null,
  argumentsValue: Json,
  retentionDays: number,
  origin: CallOrigin,
  approval?: AuditApproval
): Effect.Effect<RecordAuditInput, never, Crypto.Crypto> =>
  Effect.all([newAuditId, DateTime.now]).pipe(
    Effect.map(([id, at]): RecordAuditInput => ({
      tenantId: authorization.profile.tenantId,
      id,
      profileId: authorization.profile.id,
      caller: origin.caller,
      authorizedBySubjectId: origin.authorizedBy,
      alias: authorization.alias,
      tool: authorization.profileTool.tool,
      connection: authorization.connection,
      decision: authorization.decision,
      ...whenPresent("approval", approval),
      outcome,
      message,
      arguments: {
        value: argumentsValue,
        expiresAt: DateTime.toDateUtc(DateTime.addDuration(at, Duration.days(retentionDays)))
      }
    }))
  )

/** When a call frozen now stops waiting, by its profile's setting; never for a profile that waits until someone decides. */
const approvalExpiry = (profile: Profile): Effect.Effect<Date | null> =>
  profile.approvalExpiryMinutes === null
    ? Effect.succeed(null)
    : Effect.map(DateTime.now, (now) =>
        DateTime.toDateUtc(DateTime.addDuration(now, Duration.minutes(profile.approvalExpiryMinutes ?? 0)))
      )

const freezeOrCollect = Effect.fn("Invocation.freezeOrCollect")(function* (
  dependencies: {
    readonly store: GatewayStore
    readonly integrations: Integrations["Service"]
    readonly retentionDays: number
    readonly approvalUrlOf?: InvokeDependencies["approvalUrlOf"]
    readonly onApprovalCreated?: InvokeDependencies["onApprovalCreated"]
  },
  authorization: Extract<Authorization, { status: "authorized" }>,
  argumentsValue: Json,
  origin: CallOrigin,
  relay: boolean
): Effect.fn.Return<InvocationOutcome, GatewayStoreError, Crypto.Crypto | HttpClient.HttpClient> {
  const { store, retentionDays } = dependencies
  const pending = (approvalId: ApprovalId, expiresAt: Date | null): InvocationOutcome => {
    const approvalUrl =
      authorization.profile.approvalMethod !== "none" ? dependencies.approvalUrlOf?.(approvalId) : undefined
    return {
      status: "pending",
      approvalId,
      expiresAt,
      ...whenPresent("approvalUrl", approvalUrl)
    }
  }
  const existing = yield* store.findUncollectedApproval({
    tenantId: authorization.profile.tenantId,
    profileId: authorization.profile.id,
    alias: authorization.alias,
    tool: authorization.profileTool.tool,
    subject: authorization.subject,
    arguments: argumentsValue
  })

  if (existing !== undefined && (existing.status === "pending" || existing.status === "executing")) {
    return pending(existing.id, existing.expiresAt)
  }

  if (existing !== undefined && (yield* store.collectApproval(authorization.profile.tenantId, existing.id))) {
    if (existing.status === "approved") {
      yield* store.recordAudit(
        yield* auditFor(
          authorization,
          existing.error === null ? "succeeded" : "failed",
          `result of approval ${existing.id} collected`,
          argumentsValue,
          retentionDays,
          origin
        )
      )
      return existing.error === null
        ? { status: "succeeded", result: existing.result }
        : { status: "failed", message: existing.error }
    }
    const reason =
      existing.status === "expired"
        ? `approval ${existing.id} expired before a decision was recorded`
        : `approval ${existing.id} was denied${existing.decidedBy === null ? "" : ` by ${existing.decidedBy}`}`
    yield* store.recordAudit(yield* auditFor(authorization, "denied", reason, argumentsValue, retentionDays, origin))
    return { status: "denied", reason }
  }

  const rule = (yield* store.listApprovalRules(authorization.profile.id)).find(
    (candidate) =>
      candidate.tool === authorization.profileTool.tool &&
      sameConnectionRef(candidate.connection, authorization.profileTool.connection) &&
      matchesPattern(candidate, argumentsValue)
  )
  if (rule !== undefined) {
    yield* Effect.annotateCurrentSpan("approval.rule", rule.id)
    return yield* executeAuthorized(
      { store, integrations: dependencies.integrations, retentionDays },
      authorization,
      argumentsValue,
      origin,
      { approved: { approval: "saved_approval", message: `saved approval ${rule.id}` }, relay }
    )
  }

  const id = yield* newApprovalId
  const approval = yield* store.createApproval({
    id,
    tenantId: authorization.profile.tenantId,
    profileId: authorization.profile.id,
    caller: origin.caller,
    alias: authorization.alias,
    tool: authorization.profileTool.tool,
    subject: authorization.subject,
    arguments: argumentsValue,
    groupWindowMinutes: authorization.profile.approvalGroupWindowMinutes,
    expiresAt: yield* approvalExpiry(authorization.profile)
  })
  if (approval.id !== id) return pending(approval.id, approval.expiresAt)
  yield* store.recordAudit(
    yield* auditFor(authorization, "pending", `approval ${approval.id}`, argumentsValue, retentionDays, origin)
  )
  const outcome = pending(approval.id, approval.expiresAt)
  if (dependencies.onApprovalCreated !== undefined) {
    yield* dependencies.onApprovalCreated({
      authorization,
      approvalId: approval.id,
      expiresAt: approval.expiresAt,
      ...whenPresent("approvalUrl", outcome.status === "pending" ? outcome.approvalUrl : undefined)
    })
  }
  return outcome
})

const settle = Effect.fn("Invocation.settle")(
  function* (
    dependencies: InvokeDependencies,
    tenantId: TenantId,
    authorization: Authorization,
    input: {
      readonly alias: Alias
      readonly tool: ToolName
      readonly arguments: Json
      readonly origin: CallOrigin
      readonly profileId: ProfileId | null
      readonly interaction?: Interaction
    }
  ): Effect.fn.Return<InvocationOutcome, GatewayStoreError, Crypto.Crypto | HttpClient.HttpClient> {
    const { store, integrations } = dependencies
    const interaction = input.interaction ?? noInteraction
    yield* Effect.annotateCurrentSpan({ "tool.alias": input.alias, "tool.name": input.tool })
    if (authorization.status === "authorized") {
      yield* Effect.annotateCurrentSpan({
        "connection.integration": authorization.connection.integration,
        "connection.name": authorization.connection.name,
        "tool.decision": authorization.decision
      })
    }
    const retentionDays = dependencies.argumentRetentionDays ?? defaultArgumentRetentionDays

    if (authorization.status !== "authorized") {
      const reason = authorization.message
      yield* store.recordAudit({
        tenantId,
        id: yield* newAuditId,
        profileId: input.profileId,
        caller: input.origin.caller,
        authorizedBySubjectId: input.origin.authorizedBy,
        alias: input.alias,
        tool: input.tool,
        connection: null,
        decision: null,
        outcome: "denied",
        message: reason
      })
      return { status: "denied", reason }
    }

    if (interaction.answer !== undefined) {
      return yield* continueRound({ store, integrations, retentionDays }, authorization, {
        arguments: input.arguments,
        origin: input.origin,
        relay: interaction.relay,
        answer: interaction.answer
      })
    }

    const invalid = yield* checkArguments(integrations, authorization, input.arguments)
    if (invalid !== undefined) return invalid

    const missing = yield* missingUserConnection(dependencies, authorization)
    if (missing !== undefined) return missing

    if (authorization.decision === "require_approval") {
      return yield* freezeOrCollect(
        {
          store,
          integrations,
          retentionDays,
          ...whenPresent("approvalUrlOf", dependencies.approvalUrlOf),
          ...whenPresent("onApprovalCreated", dependencies.onApprovalCreated)
        },
        authorization,
        input.arguments,
        input.origin,
        interaction.relay
      )
    }

    return yield* executeAuthorized(
      { store, integrations, retentionDays },
      authorization,
      input.arguments,
      input.origin,
      {
        relay: interaction.relay
      }
    )
  },
  Effect.tap((outcome) => Effect.annotateCurrentSpan("invocation.outcome", outcome.status))
)

const roundRefused = (message: string): InvocationOutcome => ({ status: "invalid", message, issues: [] })

/**
 * The next round of a call that asked for input: the sealed state must name
 * this profile, tool and exact arguments, and carries the approval an earlier
 * round already got, so the human is not asked twice.
 */
const continueRound = Effect.fn("Invocation.continueRound")(function* (
  dependencies: {
    readonly store: GatewayStore
    readonly integrations: Integrations["Service"]
    readonly retentionDays: number
  },
  authorization: Authorized,
  input: {
    readonly arguments: Json
    readonly origin: CallOrigin
    readonly relay: boolean
    readonly answer: NonNullable<Interaction["answer"]>
  }
): Effect.fn.Return<InvocationOutcome, GatewayStoreError, Crypto.Crypto> {
  const state = yield* openRound(dependencies.store, input.answer.requestState, {
    profileId: authorization.profile.id,
    tool: boundToolAddress(authorization.connection, authorization.profileTool.tool),
    arguments: input.arguments
  })
  if (Option.isNone(state)) {
    return roundRefused("requestState does not belong to this call or has expired. Call the tool again without it.")
  }
  const approved = state.value.approval
  if (approved === null && authorization.decision === "require_approval") {
    return roundRefused("This tool needs approval now. Call it again without requestState.")
  }
  return yield* executeAuthorized(dependencies, authorization, input.arguments, input.origin, {
    ...whenPresent("approved", approved),
    relay: input.relay,
    upstream: {
      inputResponses: input.answer.inputResponses,
      ...whenPresent("requestState", state.value.upstream)
    }
  })
})

/**
 * Arguments are checked against the tool's declared input schema before any
 * approval is frozen, so a malformed call fails fast for the caller instead of
 * failing at the vendor after a human said yes.
 */
const checkArguments = Effect.fn("Invocation.checkArguments")(function* (
  integrations: Integrations["Service"],
  authorization: Authorized,
  argumentsValue: Json
): Effect.fn.Return<InvocationOutcome | undefined> {
  const address = boundToolAddress(authorization.connection, authorization.profileTool.tool)
  const described = yield* integrations.describeTool(address).pipe(
    Effect.map(Option.some),
    Effect.catch(() => Effect.succeed(Option.none()))
  )
  if (Option.isNone(described)) return undefined
  return invalidArguments(described.value.inputSchema, argumentsValue, authorization.profileTool.tool)
})

/**
 * A delegated tool whose user has no live connection yet cannot run. Instead
 * the OAuth flow starts, bound to that user, and the caller gets what it needs
 * to send the person to their browser and try again afterwards.
 */
const missingUserConnection = Effect.fn("Invocation.missingUserConnection")(function* (
  dependencies: InvokeDependencies,
  authorization: Authorized
): Effect.fn.Return<InvocationOutcome | undefined, GatewayStoreError> {
  const connection = authorization.connection
  if (!isDelegationTemplate(authorization.profileTool.connection)) return undefined
  if (connection.owner !== "user" || connection.subject === undefined) return undefined
  const subject = connection.subject
  const held = yield* dependencies.integrations
    .listConnections({
      integration: connection.integration,
      owner: connectionOwner(connection)
    })
    .pipe(Effect.catch(() => Effect.succeed([])))
  const live = held.find((candidate) => candidate.name === connection.name && candidate.status === "connected")
  if (live !== undefined) return undefined

  const deny = (reason: string): InvocationOutcome => ({ status: "denied", reason })
  if (dependencies.oauth === undefined) {
    return deny(
      `${authorization.alias}.${authorization.profileTool.tool} needs ${subject} to connect ${connection.integration} first`
    )
  }
  const integration = yield* dependencies.integrations
    .findIntegration(connection.integration)
    .pipe(Effect.catch(() => Effect.succeed(Option.none())))
  const method = Option.isNone(integration)
    ? undefined
    : integration.value.authMethods.find((candidate) => candidate.kind === "oauth")
  if (method === undefined) {
    return deny(`${connection.integration} offers no OAuth method, so it cannot be connected on behalf of ${subject}`)
  }
  const session = yield* dependencies.oauth
    .start({
      integration: connection.integration,
      connection: connection.name,
      authMethod: method,
      bindingTenant: authorization.profile.tenantId,
      subject
    })
    .pipe(Effect.catch((failure) => Effect.succeed(failure)))
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
export const invokeThroughGateway = Effect.fn("Invocation.invokeThroughGateway")(function* (
  dependencies: InvokeDependencies,
  input: {
    readonly secret: string
    readonly alias: Alias
    readonly tool: ToolName
    readonly arguments: Json
    readonly subject?: SubjectId
  }
): Effect.fn.Return<InvocationOutcome, GatewayStoreError, Crypto.Crypto | HttpClient.HttpClient> {
  const authentication = yield* authenticateKey(dependencies.store, input.secret)
  if (authentication.status !== "authenticated") {
    return yield* settle(dependencies, defaultTenantId, authentication, {
      ...input,
      origin: unattributedOrigin,
      profileId: null
    })
  }
  const authorization = yield* authorizeProfileInvocation(dependencies.store, authentication.profile, input)
  return yield* settle(dependencies, authentication.profile.tenantId, authorization, {
    ...input,
    origin: keyOrigin(authentication.key),
    profileId: authentication.profile.id
  })
})

/**
 * An invocation on behalf of a profile the host already identified: the same
 * decision, approval, and audit path, with no key to present or check.
 */
export const invokeAsProfile = Effect.fn("Invocation.invokeAsProfile")(function* (
  dependencies: InvokeDependencies,
  input: {
    readonly profile: Profile
    readonly origin: CallOrigin
    readonly alias: Alias
    readonly tool: ToolName
    readonly arguments: Json
    readonly subject?: SubjectId
    readonly interaction?: Interaction
  }
): Effect.fn.Return<InvocationOutcome, GatewayStoreError, Crypto.Crypto | HttpClient.HttpClient> {
  const authorization = yield* authorizeProfileInvocation(dependencies.store, input.profile, input)
  return yield* settle(dependencies, input.profile.tenantId, authorization, {
    ...input,
    profileId: input.profile.id
  })
})

/** How a call came to run, and the round it continues. */
export interface ExecutionRound {
  /** How the call that asked got its approval; nothing for a call that runs directly. */
  readonly approved?: RoundApproval
  /** The approval it ran under, which a host tool is told about. */
  readonly approvalId?: ApprovalId
  /** Whether a round of input the tool asks for goes back to the caller. */
  readonly relay?: boolean
  readonly upstream?: InputAnswer
}

export const executeAuthorized = Effect.fn("Invocation.executeAuthorized")(function* (
  dependencies: {
    readonly store: GatewayStore
    readonly integrations: Integrations["Service"]
    readonly retentionDays: number
  },
  authorization: Extract<Authorization, { status: "authorized" }>,
  argumentsValue: Json,
  origin: CallOrigin,
  round: ExecutionRound = {}
): Effect.fn.Return<
  Extract<InvocationOutcome, { status: "succeeded" | "failed" | "input-required" }>,
  GatewayStoreError,
  Crypto.Crypto
> {
  const address = boundToolAddress(authorization.connection, authorization.profileTool.tool)
  const approved = round.approved
  const record = (outcome: "succeeded" | "failed", message: string | null) =>
    Effect.flatMap(
      auditFor(authorization, outcome, message, argumentsValue, dependencies.retentionDays, origin, approved?.approval),
      dependencies.store.recordAudit
    )
  const context: ToolCallContext = {
    tenantId: authorization.profile.tenantId,
    profileId: authorization.profile.id,
    ...whenPresent("subject", authorization.subject),
    ...whenPresent("approvalId", round.approvalId)
  }
  const invocation = yield* Effect.result(
    dependencies.integrations.execute(address, argumentsValue, round.upstream, context)
  )
  if (invocation._tag === "Failure") {
    yield* record("failed", invocation.failure.message)
    return { status: "failed", message: invocation.failure.message }
  }
  const execution = invocation.success
  if (execution.kind === "complete") {
    yield* record("succeeded", approved?.message ?? null)
    return { status: "succeeded", result: execution.result }
  }
  const { inputRequests, requestState } = execution.round
  if (round.relay !== true || !relayableInput(inputRequests)) {
    const message = unrelayableInputMessage(inputRequests)
    yield* record("failed", message)
    return { status: "failed", message }
  }
  return {
    status: "input-required",
    inputRequests,
    requestState: yield* sealRound(
      dependencies.store,
      { profileId: authorization.profile.id, tool: address, arguments: argumentsValue },
      { approval: approved ?? null, upstream: requestState }
    )
  }
})

export type EffectiveTool = {
  readonly alias: Alias
  readonly tool: ToolName
  readonly connection: ConnectionRef
  readonly decision: ToolDecision
  /** The tool runs on the calling user's own connection; invocations must name a subject. */
  readonly delegated: boolean
  /** What the tool's source says about it; absent when the catalog no longer holds the tool. */
  readonly readOnly?: boolean
  readonly destructive?: boolean
  readonly idempotent?: boolean
  readonly description?: string
  readonly inputSchema?: Json
  readonly outputSchema?: Json
}

type ToolHints = Pick<ToolSummary, "readOnly" | "destructive" | "idempotent">

/** A template names no connection of its own, so any user's connection of that name speaks for its tools. */
const hintKey = (integration: string, owner: string, connection: string, tool: string): string =>
  [integration, owner, connection, tool].join("\u0000")

const hintKeyOf = (connection: ConnectionRef, tool: ToolName): string =>
  hintKey(
    connection.integration,
    isDelegationTemplate(connection) ? "user" : connectionOwner(connection),
    connection.name,
    tool
  )

/**
 * A profile's tools with their decisions. Given the integration host, each one
 * also carries what its source says about it, and its schemas when asked for.
 */
export const listEffectiveTools = Effect.fn("Invocation.listEffectiveTools")(function* (
  store: GatewayStore,
  profileId: ProfileId,
  options: {
    readonly schemas?: boolean
    readonly integrations?: Pick<Integrations["Service"], "toolSummaries" | "listConnections" | "describeTool">
    readonly integration?: IntegrationSlug
    readonly connection?: ConnectionName
  } = {}
): Effect.fn.Return<ReadonlyArray<EffectiveTool>, GatewayStoreError> {
  const enabled = (yield* store.listProfileTools(profileId)).filter(
    (profileTool) =>
      (options.integration === undefined || profileTool.connection.integration === options.integration) &&
      (options.connection === undefined || profileTool.connection.name === options.connection)
  )
  const host = options.integrations
  const hints = new Map<string, ToolHints>()
  if (host !== undefined) {
    const summaries = yield* host
      .toolSummaries(whenPresent("integration", options.integration))
      .pipe(
        Effect.catch((failure) =>
          Effect.logWarning(`No tool hints: ${failure.message}`).pipe(Effect.as<ReadonlyArray<ToolSummary>>([]))
        )
      )
    for (const summary of summaries) {
      const hinted = { readOnly: summary.readOnly, destructive: summary.destructive, idempotent: summary.idempotent }
      hints.set(hintKey(summary.integration, summary.owner, summary.connection, summary.name), hinted)
      if (summary.owner !== "org")
        hints.set(hintKey(summary.integration, "user", summary.connection, summary.name), hinted)
    }
  }
  const base = enabled.map((profileTool): EffectiveTool => {
    const hinted = hints.get(hintKeyOf(profileTool.connection, profileTool.tool))
    return {
      alias: aliasForConnection(profileTool.connection),
      tool: profileTool.tool,
      connection: profileTool.connection,
      decision: profileTool.decision,
      delegated: isDelegationTemplate(profileTool.connection),
      ...whenPresent("readOnly", hinted?.readOnly),
      ...whenPresent("destructive", hinted?.destructive),
      ...whenPresent("idempotent", hinted?.idempotent)
    }
  })
  if (options.schemas !== true || host === undefined) return base

  /** A template names no connection of its own; any held connection of the integration describes the tool. */
  const addressOf = (entry: { readonly connection: ConnectionRef; readonly tool: ToolName }) =>
    isDelegationTemplate(entry.connection)
      ? host.listConnections({ integration: entry.connection.integration }).pipe(
          Effect.map((held) => {
            const sample = held[0]
            return sample === undefined
              ? Option.none<ToolAddress>()
              : Option.some(
                  boundToolAddress(connectionRefOf(sample.owner, sample.integration, sample.name), entry.tool)
                )
          }),
          Effect.catch(() => Effect.succeed(Option.none<ToolAddress>()))
        )
      : Effect.succeed(Option.some(boundToolAddress(entry.connection, entry.tool)))
  const describe = (entry: EffectiveTool, address: ToolAddress) =>
    host.describeTool(address).pipe(
      Effect.map((described) => ({
        ...entry,
        ...whenPresent("description", described.description),
        ...whenPresent("inputSchema", described.inputSchema),
        ...whenPresent("outputSchema", described.outputSchema)
      })),
      Effect.catch((failure) =>
        Effect.as(
          Effect.logWarning(`No schema for ${entry.alias}.${entry.tool}: ${failure.message}`).pipe(
            Effect.annotateLogs({
              alias: entry.alias,
              tool: entry.tool,
              operation: "listEffectiveTools.describe"
            })
          ),
          entry
        )
      )
    )
  return yield* Effect.forEach(
    base,
    (entry) =>
      Effect.flatMap(
        addressOf(entry),
        Option.match({
          onNone: () => Effect.succeed(entry),
          onSome: (address) => describe(entry, address)
        })
      ),
    { concurrency: "unbounded" }
  )
})
