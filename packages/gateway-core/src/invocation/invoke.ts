import {
  connectionOwner,
  InvalidInput,
  isDelegationTemplate,
  matchesPattern,
  whenPresent
} from "@integragents/contracts"
import type { IdempotencyKey, InputResponses, InvocationOutcome, Json } from "@integragents/contracts"
import { Crypto, DateTime, Duration, Effect, Option } from "effect"
import type { HttpClient } from "effect/http"
import type { Integrations, StorageError } from "@integragents/integrations"
import type { OAuthSessions } from "../connection-oauth/sessions.ts"
import { invalidArguments } from "./arguments.ts"
import { authorizeProfileInvocation } from "./authorize.ts"
import { defaultArgumentRetentionDays } from "../config.ts"
import { sameConnectionRef } from "../domain.ts"
import type {
  Alias,
  ApprovalId,
  Authorized,
  CallOrigin,
  Authorization,
  PendingApproval,
  Profile,
  ProfileId,
  SubjectId,
  TenantId,
  ToolName
} from "../domain.ts"
import { approvalOutcome } from "../approvals/decided.ts"
import { approveApproval, denyApproval } from "../approvals/decide.ts"
import { auditFor, boundToolAddress, executeAuthorized } from "./execute.ts"
import { openRound } from "./input-rounds.ts"
import { newApprovalId, newAuditId } from "../keys.ts"
import { consultReviewer, reviewerIdentity } from "../approvals/reviewer.ts"
import type { ApprovalReviewer, ApprovalReviewRequest } from "../approvals/reviewer.ts"
import type {
  ApprovalStore,
  AuditStore,
  GatewayStoreError,
  InvocationKeyRecord,
  InvocationKeyStore,
  ProfileStore,
  SealedStateStore
} from "../store/index.ts"

export interface InvokeDependencies {
  readonly store: ApprovalStore & AuditStore & InvocationKeyStore & ProfileStore & SealedStateStore
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
  /** Consulted on every new call that asks, before a human is notified. See `ApprovalReviewer`. */
  readonly reviewer?: ApprovalReviewer["Service"]
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

/** When a call frozen now stops waiting, by its profile's setting; never for a profile that waits until someone decides. */
const approvalExpiry = (profile: Profile): Effect.Effect<Date | null> =>
  profile.approvalExpiryMinutes === null
    ? Effect.succeed(null)
    : Effect.map(DateTime.now, (now) =>
        DateTime.toDateUtc(DateTime.addDuration(now, Duration.minutes(profile.approvalExpiryMinutes ?? 0)))
      )

/** The frozen call, and what the catalog knows of its tool, for a reviewer to judge. */
const reviewRequest = Effect.fn("Invocation.reviewRequest")(function* (
  integrations: Integrations["Service"],
  authorization: Authorized,
  approval: PendingApproval
) {
  const described = yield* integrations
    .describeTool(boundToolAddress(authorization.connection, authorization.profileTool.tool))
    .pipe(Effect.option)
  const tool = Option.getOrUndefined(described)
  return {
    tenantId: authorization.profile.tenantId,
    approval,
    profile: authorization.profile,
    connection: authorization.connection,
    tool: {
      alias: authorization.alias,
      name: authorization.profileTool.tool,
      ...whenPresent("description", tool?.description),
      ...whenPresent("inputSchema", tool?.inputSchema),
      ...whenPresent("readOnly", tool?.readOnly),
      ...whenPresent("destructive", tool?.destructive),
      ...whenPresent("idempotent", tool?.idempotent)
    }
  } satisfies ApprovalReviewRequest
})

/** A call waiting on a human, with the link to decide it when the profile hands one out. */
const pendingOutcome = (
  dependencies: { readonly approvalUrlOf?: InvokeDependencies["approvalUrlOf"] },
  profile: Profile,
  approvalId: ApprovalId,
  expiresAt: Date | null
): InvocationOutcome => {
  const approvalUrl = profile.approvalMethod !== "none" ? dependencies.approvalUrlOf?.(approvalId) : undefined
  return { status: "pending", approvalId, expiresAt, ...whenPresent("approvalUrl", approvalUrl) }
}

const freezeOrCollect = Effect.fn("Invocation.freezeOrCollect")(function* (
  dependencies: {
    readonly store: ApprovalStore & AuditStore & InvocationKeyStore & ProfileStore & SealedStateStore
    readonly integrations: Integrations["Service"]
    readonly retentionDays: number
    readonly approvalUrlOf?: InvokeDependencies["approvalUrlOf"]
    readonly onApprovalCreated?: InvokeDependencies["onApprovalCreated"]
    readonly reviewer?: InvokeDependencies["reviewer"]
  },
  authorization: Extract<Authorization, { status: "authorized" }>,
  argumentsValue: Json,
  origin: CallOrigin,
  relay: boolean,
  /** A keyed call is never merged with an identical one; its key, not its arguments, finds its approval. */
  idempotencyKey: IdempotencyKey | undefined
): Effect.fn.Return<InvocationOutcome, GatewayStoreError | StorageError, Crypto.Crypto | HttpClient.HttpClient> {
  const { store, retentionDays } = dependencies
  const pending = (approvalId: ApprovalId, expiresAt: Date | null): InvocationOutcome =>
    pendingOutcome(dependencies, authorization.profile, approvalId, expiresAt)
  const existing =
    idempotencyKey !== undefined
      ? undefined
      : yield* store.findUncollectedApproval({
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

  const collected = existing === undefined ? undefined : approvalOutcome(existing)
  if (
    existing !== undefined &&
    collected !== undefined &&
    (yield* store.collectApproval(authorization.profile.tenantId, existing.id))
  ) {
    yield* store.recordAudit(
      yield* auditFor(
        authorization,
        collected.status,
        collected.status === "denied" ? collected.reason : `result of approval ${existing.id} collected`,
        argumentsValue,
        retentionDays,
        origin
      )
    )
    return collected
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
      {
        approved: { approval: "saved_approval", message: `saved approval ${rule.id}` },
        relay,
        ...whenPresent("idempotencyKey", idempotencyKey)
      }
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
    ...whenPresent("idempotencyKey", idempotencyKey),
    arguments: argumentsValue,
    groupWindowMinutes: authorization.profile.approvalGroupWindowMinutes,
    expiresAt: yield* approvalExpiry(authorization.profile)
  })
  if (approval.id !== id) return pending(approval.id, approval.expiresAt)
  const reviewer = dependencies.reviewer
  const review =
    reviewer === undefined
      ? undefined
      : {
          by: reviewerIdentity(reviewer),
          verdict: yield* consultReviewer(
            reviewer,
            yield* reviewRequest(dependencies.integrations, authorization, approval)
          )
        }
  const escalation =
    review?.verdict.verdict === "escalate"
      ? `; ${review.by} left it to a human${review.verdict.reason === undefined ? "" : `: ${review.verdict.reason}`}`
      : ""
  yield* store.recordAudit(
    yield* auditFor(
      authorization,
      "pending",
      `approval ${approval.id}${escalation}`,
      argumentsValue,
      retentionDays,
      origin
    )
  )
  const tenantId = authorization.profile.tenantId
  const decision = { tenantId, id: approval.id, decidedBy: review?.by ?? null }
  /** Another decision got there first; the call is whatever that made of it. */
  const raced = () => Effect.succeed(pending(approval.id, approval.expiresAt))
  if (review?.verdict.verdict === "approve") {
    const decided = yield* approveApproval(
      { store, integrations: dependencies.integrations, retentionDays },
      { ...decision, ...whenPresent("reason", review.verdict.reason) },
      "approved",
      relay
    ).pipe(
      Effect.map(({ outcome }): InvocationOutcome => outcome),
      Effect.catchTags({ NotFound: raced, ApprovalConflict: raced, InvalidInput: raced })
    )
    if (decided.status === "succeeded" || decided.status === "failed")
      yield* store.collectApproval(tenantId, approval.id)
    return decided
  }
  if (review?.verdict.verdict === "deny") {
    const denied = yield* denyApproval(store, { ...decision, ...whenPresent("reason", review.verdict.reason) }).pipe(
      Effect.map(({ approval: settled }) => approvalOutcome(settled)),
      Effect.catchTags({ NotFound: raced, ApprovalConflict: raced })
    )
    if (denied === undefined || denied.status !== "denied") return denied ?? pending(approval.id, approval.expiresAt)
    yield* store.recordAudit(
      yield* auditFor(authorization, "denied", denied.reason, argumentsValue, retentionDays, origin)
    )
    yield* store.collectApproval(tenantId, approval.id)
    return denied
  }
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
      readonly idempotencyKey?: IdempotencyKey
    }
  ): Effect.fn.Return<InvocationOutcome, GatewayStoreError | StorageError, Crypto.Crypto | HttpClient.HttpClient> {
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

    const decide = (idempotencyKey: IdempotencyKey | undefined) =>
      Effect.flatMap(run(idempotencyKey), (outcome) => stepUpScopes(dependencies, authorization, outcome))
    const run = (idempotencyKey: IdempotencyKey | undefined) =>
      authorization.decision === "require_approval"
        ? freezeOrCollect(
            {
              store,
              integrations,
              retentionDays,
              ...whenPresent("approvalUrlOf", dependencies.approvalUrlOf),
              ...whenPresent("onApprovalCreated", dependencies.onApprovalCreated),
              ...whenPresent("reviewer", dependencies.reviewer)
            },
            authorization,
            input.arguments,
            input.origin,
            interaction.relay,
            idempotencyKey
          )
        : executeAuthorized({ store, integrations, retentionDays }, authorization, input.arguments, input.origin, {
            relay: interaction.relay,
            ...whenPresent("idempotencyKey", idempotencyKey)
          })

    const key = input.idempotencyKey
    if (key === undefined) return yield* decide(undefined)
    yield* Effect.annotateCurrentSpan("invocation.idempotency_key", key)
    const keyed = { tenantId: authorization.profile.tenantId, profileId: authorization.profile.id, key }
    const earlier = yield* store.claimInvocationKey({
      ...keyed,
      call: {
        alias: authorization.alias,
        tool: authorization.profileTool.tool,
        subject: authorization.subject,
        arguments: input.arguments
      }
    })
    if (earlier !== undefined) {
      return yield* replayKeyed(
        { store, retentionDays, ...whenPresent("approvalUrlOf", dependencies.approvalUrlOf) },
        authorization,
        earlier,
        { arguments: input.arguments, origin: input.origin }
      )
    }
    const outcome = yield* decide(key)
    yield* rememberKeyed(store, keyed, outcome)
    return outcome
  },
  Effect.tap((outcome) => Effect.annotateCurrentSpan("invocation.outcome", outcome.status))
)

/**
 * What a keyed call is remembered as. A call that waits is remembered by its
 * approval, one that ran or was refused by its outcome; a round of input is
 * not worth remembering, so its key is freed for the call to be made again.
 */
const rememberKeyed = Effect.fn("Invocation.rememberKeyed")(function* (
  store: ApprovalStore & AuditStore & InvocationKeyStore & ProfileStore & SealedStateStore,
  keyed: { readonly tenantId: TenantId; readonly profileId: ProfileId; readonly key: IdempotencyKey },
  outcome: InvocationOutcome
) {
  switch (outcome.status) {
    case "pending":
      yield* store.settleInvocationKey({ ...keyed, from: "running", to: { approvalId: outcome.approvalId } })
      return
    case "succeeded":
    case "failed":
    case "denied":
      yield* store.settleInvocationKey({ ...keyed, from: "running", to: { outcome } })
      return
    case "invalid":
    case "authorization-required":
    case "input-required":
      yield* store.releaseInvocationKey(keyed)
      return
  }
})

/**
 * A repeat of a keyed call: the same answer the first one got, never a second
 * run. A call still waiting answers with its approval; once that is decided,
 * the first repeat collects the outcome and every later one gets it again.
 */
const replayKeyed = Effect.fn("Invocation.replayKeyed")(function* (
  dependencies: {
    readonly store: ApprovalStore & AuditStore & InvocationKeyStore & ProfileStore & SealedStateStore
    readonly retentionDays: number
    readonly approvalUrlOf?: InvokeDependencies["approvalUrlOf"]
  },
  authorization: Authorized,
  earlier: InvocationKeyRecord,
  input: { readonly arguments: Json; readonly origin: CallOrigin }
): Effect.fn.Return<InvocationOutcome, GatewayStoreError | StorageError, Crypto.Crypto> {
  const { store } = dependencies
  if (!earlier.sameCall) {
    return refused(
      "idempotencyKey",
      `${earlier.key} was first used for ${earlier.alias}.${earlier.tool} with other arguments; use a new key for a different call`
    )
  }
  if (earlier.status === "settled" && earlier.outcome !== null) return earlier.outcome
  if (earlier.status === "running" || earlier.approvalId === null) {
    return {
      status: "failed",
      message:
        `The call made with idempotency key ${earlier.key} has not recorded an outcome: it is still running, ` +
        "or it was interrupted. It was not run again."
    }
  }
  const tenantId = authorization.profile.tenantId
  const approval = yield* store.getApproval(tenantId, earlier.approvalId)
  if (approval === undefined) {
    return { status: "failed", message: `Approval ${earlier.approvalId} of this call no longer exists` }
  }
  const outcome = approvalOutcome(approval)
  if (outcome === undefined) return pendingOutcome(dependencies, authorization.profile, approval.id, approval.expiresAt)
  const collected = yield* store.settleInvocationKey({
    tenantId,
    profileId: authorization.profile.id,
    key: earlier.key,
    from: "pending",
    to: { outcome }
  })
  if (collected) {
    yield* store.collectApproval(tenantId, approval.id)
    yield* store.recordAudit(
      yield* auditFor(
        authorization,
        outcome.status,
        outcome.status === "denied" ? outcome.reason : `result of approval ${approval.id} collected`,
        input.arguments,
        dependencies.retentionDays,
        input.origin
      )
    )
  }
  return outcome
})

const refused = (field: string, problem: string): InvocationOutcome => ({
  status: "invalid",
  error: new InvalidInput({ field, problem })
})

/**
 * The next round of a call that asked for input: the sealed state must name
 * this profile, tool and exact arguments, and carries the approval an earlier
 * round already got, so the human is not asked twice.
 */
const continueRound = Effect.fn("Invocation.continueRound")(function* (
  dependencies: {
    readonly store: ApprovalStore & AuditStore & InvocationKeyStore & ProfileStore & SealedStateStore
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
): Effect.fn.Return<InvocationOutcome, GatewayStoreError | StorageError, Crypto.Crypto> {
  const state = yield* openRound(dependencies.store, input.answer.requestState, {
    profileId: authorization.profile.id,
    tool: boundToolAddress(authorization.connection, authorization.profileTool.tool),
    arguments: input.arguments
  })
  if (Option.isNone(state)) {
    return refused("requestState", "it does not belong to this call or has expired; call the tool again without it")
  }
  const approved = state.value.approval
  if (approved === null && authorization.decision === "require_approval") {
    return refused("requestState", "this tool needs approval now; call it again without requestState")
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
): Effect.fn.Return<InvocationOutcome | undefined, GatewayStoreError | StorageError> {
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

  return yield* startAuthorization(dependencies, authorization, {
    subject,
    unavailable: `${authorization.alias}.${authorization.profileTool.tool} needs ${subject} to connect ${connection.integration} first`
  })
})

/**
 * Starts the OAuth flow a call is waiting on and answers with what the human
 * needs to finish it. `scopes` replaces what the integration asks for by
 * default, for a connection the provider wants more access on.
 */
const startAuthorization = Effect.fn("Invocation.startAuthorization")(function* (
  dependencies: InvokeDependencies,
  authorization: Authorized,
  request: {
    readonly subject?: SubjectId
    readonly scopes?: ReadonlyArray<string>
    /** Why the call cannot run, for a gateway that cannot start flows. */
    readonly unavailable: string
  }
): Effect.fn.Return<InvocationOutcome> {
  const connection = authorization.connection
  const forWhom = request.subject === undefined ? "" : ` on behalf of ${request.subject}`
  const deny = (reason: string): InvocationOutcome => ({ status: "denied", reason })
  if (dependencies.oauth === undefined) return deny(request.unavailable)
  const integration = yield* dependencies.integrations
    .findIntegration(connection.integration)
    .pipe(Effect.catch(() => Effect.succeed(Option.none())))
  const method = Option.isNone(integration)
    ? undefined
    : integration.value.authMethods.find((candidate) => candidate.kind === "oauth")
  if (method === undefined) {
    return deny(`${connection.integration} offers no OAuth method, so it cannot be authorized${forWhom}`)
  }
  const session = yield* dependencies.oauth
    .start({
      integration: connection.integration,
      connection: connection.name,
      authMethod:
        request.scopes === undefined ? method : { ...method, oauth: { ...method.oauth, scopes: [...request.scopes] } },
      bindingTenant: authorization.profile.tenantId,
      ...whenPresent("subject", request.subject)
    })
    .pipe(Effect.catch((failure) => Effect.succeed(failure)))
  if ("_tag" in session) {
    return deny(`${connection.integration} could not start authorization${forWhom}: ${session.message}`)
  }
  return {
    status: "authorization-required",
    integration: connection.integration,
    connection: connection.name,
    ...whenPresent("subject", request.subject),
    ...whenPresent("scopes", request.scopes),
    session: { id: session.id, integration: session.integration, connection: session.connection, state: session.state }
  }
})

/**
 * A call the provider refused for a scope the connection lacks is not a dead
 * end: the flow starts again asking for what the connection already holds
 * plus what the provider named, and the caller is sent to a human with it.
 * Whoever finishes a flow binds their account to the connection, so one the
 * organization holds is only re-authorized for a profile that may provision
 * connections; anyone else gets the refusal, which says what to grant.
 */
const stepUpScopes = Effect.fn("Invocation.stepUpScopes")(function* (
  dependencies: InvokeDependencies,
  authorization: Authorized,
  outcome: InvocationOutcome
): Effect.fn.Return<InvocationOutcome> {
  if (outcome.status !== "failed" || outcome.error?._tag !== "OAuthScopeRequired") return outcome
  const required = outcome.error.scopes
  const connection = authorization.connection
  if (connection.owner !== "user" && !authorization.profile.capabilities.includes("provision_connections")) {
    return outcome
  }
  const held = yield* dependencies.integrations
    .listConnections({ integration: connection.integration, owner: connectionOwner(connection) })
    .pipe(Effect.catch(() => Effect.succeed([])))
  const granted = (held.find((candidate) => candidate.name === connection.name)?.oauthScope ?? "")
    .split(/\s+/)
    .filter((scope) => scope.length > 0)
  const stepped = yield* startAuthorization(dependencies, authorization, {
    ...whenPresent("subject", connection.owner === "user" ? connection.subject : undefined),
    scopes: [...new Set([...granted, ...required])],
    unavailable: outcome.message
  })
  return stepped.status === "authorization-required" ? stepped : outcome
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
    /**
     * Names the call across its retries: a repeat gets the first call's
     * outcome, or waits on its approval, instead of running again, and is
     * refused when it names another tool or other arguments. Ignored when
     * `interaction` answers a round of input.
     */
    readonly idempotencyKey?: IdempotencyKey
  }
): Effect.fn.Return<InvocationOutcome, GatewayStoreError | StorageError, Crypto.Crypto | HttpClient.HttpClient> {
  const authorization = yield* authorizeProfileInvocation(dependencies.store, input.profile, input)
  return yield* settle(dependencies, input.profile.tenantId, authorization, {
    ...input,
    profileId: input.profile.id
  })
})
