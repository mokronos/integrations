import { Clock, Effect, Option, Schema } from "effect"
import type { Integrations } from "@integragents/host"
import { argumentPattern, InvocationIssue, whenPresent } from "@integragents/contracts"
import type { Json } from "@integragents/contracts"
import {
  aliasForConnection,
  ApprovalId,
  type ApprovalVerdict,
  type DecidedApproval,
  connectionSubject,
  isDelegationTemplate,
  TenantId
} from "./domain.ts"
import type { AuditApproval, Authorized, ConnectionRef, PendingApproval } from "./domain.ts"
import { invalidArguments } from "./arguments.ts"
import { boundToolAddress, executeAuthorized } from "./invoke.ts"
import { newApprovalRuleId } from "./keys.ts"
import type { GatewayStore, GatewayStoreError } from "./store.ts"

export class ApprovalNotFound extends Schema.TaggedError<ApprovalNotFound>()("ApprovalNotFound", {
  id: ApprovalId
}) {}

export class ApprovalConflict extends Schema.TaggedError<ApprovalConflict>()("ApprovalConflict", {
  message: Schema.String
}) {}

/** The approver's replacement arguments do not fit the tool's input schema; nothing was decided. */
export class ApprovalArgumentsInvalid extends Schema.TaggedError<ApprovalArgumentsInvalid>()(
  "ApprovalArgumentsInvalid",
  { message: Schema.String, issues: Schema.Array(InvocationIssue) }
) {}

const ApprovalDecision = Schema.Struct({
  tenantId: TenantId,
  id: ApprovalId,
  decidedBy: Schema.NullOr(Schema.String)
})

/** The authority a frozen call was made under, if its profile still enables that tool. */
const frozenAuthorization = Effect.fn("Approvals.frozenAuthorization")(function* (
  store: GatewayStore,
  tenantId: TenantId,
  approval: PendingApproval
): Effect.fn.Return<Authorized | undefined, GatewayStoreError> {
  const profile = yield* store.findProfileById(tenantId, approval.profileId)
  if (profile === undefined || profile.revokedAt !== null) return undefined
  const profileTool = (yield* store.listProfileTools(profile.id)).find(
    (candidate) => candidate.tool === approval.tool && aliasForConnection(candidate.connection) === approval.alias
  )
  if (profileTool === undefined) return undefined
  // A delegated tool was frozen for the person the call named, and runs on their connection.
  const connection: ConnectionRef =
    isDelegationTemplate(profileTool.connection) && approval.subject !== null
      ? {
          owner: "user",
          subject: approval.subject,
          integration: profileTool.connection.integration,
          name: profileTool.connection.name
        }
      : profileTool.connection
  return {
    status: "authorized",
    profile,
    profileTool,
    alias: aliasForConnection(profileTool.connection),
    connection,
    subject: connectionSubject(connection) ?? approval.subject,
    decision: profileTool.decision
  }
})

const pendingApproval = Effect.fn("Approvals.pending")(function* (
  store: GatewayStore,
  input: typeof ApprovalDecision.Type
) {
  const { tenantId, id } = input
  const approval = yield* store.getApproval(tenantId, id)
  if (approval === undefined) return yield* new ApprovalNotFound({ id })
  if (approval.status !== "pending") {
    return yield* new ApprovalConflict({ message: `Approval ${id} is already ${approval.status}` })
  }
  const now = yield* Clock.currentTimeMillis
  if (approval.expiresAt !== null && approval.expiresAt.getTime() <= now) {
    yield* store.settleApproval({
      tenantId,
      id,
      status: "expired",
      decidedBy: null,
      result: null,
      error: "expired before a decision was recorded"
    })
    return yield* new ApprovalConflict({ message: `Approval ${id} expired` })
  }
  return approval
})

export const denyApproval = Effect.fn("Approvals.deny")(function* (
  store: GatewayStore,
  input: typeof ApprovalDecision.Type
) {
  yield* pendingApproval(store, input)
  const settled = yield* store.settleApproval({ ...input, status: "denied", result: null, error: null })
  if (!settled) return yield* new ApprovalConflict({ message: `Approval ${input.id} has already been decided` })
  const approval = yield* store.getApproval(input.tenantId, input.id)
  if (approval === undefined) return yield* new ApprovalNotFound({ id: input.id })
  return { approval }
})

export const approveApproval = Effect.fn("Approvals.approve")(function* (
  dependencies: {
    readonly store: GatewayStore
    readonly integrations: Integrations["Service"]
    readonly retentionDays: number
  },
  input: typeof ApprovalDecision.Type & {
    /** Runs instead of the frozen arguments, once they pass the tool's input schema. Both are kept. */
    readonly arguments?: Json
  },
  approval: Extract<AuditApproval, "approved" | "approved_always"> = "approved",
  relay = false
) {
  const { store } = dependencies
  const { tenantId, id, decidedBy } = input
  const frozen = yield* pendingApproval(store, input)
  const authorization = yield* frozenAuthorization(store, tenantId, frozen)
  if (authorization === undefined) {
    yield* store.settleApproval({
      tenantId,
      id,
      status: "denied",
      decidedBy,
      result: null,
      error: "the profile was revoked or stopped enabling this tool while the call was frozen"
    })
    return yield* new ApprovalConflict({ message: `Approval ${id} is no longer authorized` })
  }

  const edited = input.arguments
  if (edited !== undefined) {
    const described = yield* dependencies.integrations
      .describeTool(boundToolAddress(authorization.connection, authorization.profileTool.tool))
      .pipe(Effect.option)
    const invalid = Option.isSome(described)
      ? invalidArguments(described.value.inputSchema, edited, authorization.profileTool.tool)
      : undefined
    if (invalid !== undefined) return yield* new ApprovalArgumentsInvalid(invalid)
  }

  return yield* Effect.gen(function* () {
    const claimed = yield* store.claimApproval({
      tenantId,
      id,
      decidedBy,
      ...whenPresent("editedArguments", edited)
    })
    if (!claimed) return yield* new ApprovalConflict({ message: `Approval ${id} was decided or expired` })
    const message =
      decidedBy === null ? null : `approved by ${decidedBy}${edited === undefined ? "" : " with edited arguments"}`
    const outcome = yield* executeAuthorized(
      dependencies,
      authorization,
      edited ?? frozen.arguments,
      { caller: frozen.caller, authorizedBy: null },
      { approved: { approval, message }, approvalId: id, relay }
    )
    yield* store.settleApproval({
      tenantId,
      id,
      status: "approved",
      decidedBy,
      result: outcome.status === "succeeded" ? outcome.result : null,
      error: outcome.status === "failed" ? outcome.message : null
    })
    if (outcome.status === "input-required") yield* store.collectApproval(tenantId, id)
    const settled = yield* store.getApproval(tenantId, id)
    if (settled === undefined) return yield* new ApprovalNotFound({ id })
    return { approval: settled, outcome }
  }).pipe(Effect.uninterruptible)
})

/**
 * Saves "always approve" for the calls being approved: what they all agree on
 * is pinned, what differs between them is left open.
 */
const rememberApproval = Effect.fn("Approvals.remember")(function* (
  store: GatewayStore,
  input: { readonly tenantId: TenantId; readonly ids: ReadonlyArray<ApprovalId>; readonly decidedBy: string | null }
) {
  const approvals: Array<PendingApproval> = []
  for (const id of input.ids) {
    const approval = yield* store.getApproval(input.tenantId, id)
    if (approval?.status === "pending") approvals.push(approval)
  }
  const [first] = approvals
  if (first === undefined)
    return yield* new ApprovalConflict({ message: "None of these calls is still waiting for a decision" })
  if (
    approvals.some(
      (approval) =>
        approval.profileId !== first.profileId || approval.alias !== first.alias || approval.tool !== first.tool
    )
  ) {
    return yield* new ApprovalConflict({
      message: "A saved approval covers one tool of one profile; these calls span several"
    })
  }
  const authorization = yield* frozenAuthorization(store, input.tenantId, first)
  if (authorization === undefined)
    return yield* new ApprovalConflict({ message: `Approval ${first.id} is no longer authorized` })
  return yield* store.createApprovalRule({
    id: yield* newApprovalRuleId,
    profileId: authorization.profile.id,
    connection: authorization.profileTool.connection,
    tool: authorization.profileTool.tool,
    pattern: argumentPattern(approvals.map((approval) => approval.arguments)),
    createdBy: input.decidedBy
  })
})

/**
 * A decision by the human the call is waiting on, recorded the way the
 * dashboard records one. An approved call runs here; when it asks for input
 * the caller can relay, the round comes back for the caller instead of being
 * stored for collection.
 */
export const decideWaitingApproval = Effect.fn("Approvals.decideWaiting")(function* (
  dependencies: Parameters<typeof approveApproval>[0],
  input: {
    readonly tenantId: TenantId
    readonly id: ApprovalId
    readonly verdict: ApprovalVerdict
    readonly decidedBy: string | null
    readonly remember: boolean
    readonly relay: boolean
  }
) {
  const decision = { tenantId: input.tenantId, id: input.id, decidedBy: input.decidedBy }
  if (input.verdict === "deny") {
    yield* denyApproval(dependencies.store, decision)
    return undefined
  }
  const rule = input.remember
    ? yield* rememberApproval(dependencies.store, {
        tenantId: input.tenantId,
        ids: [input.id],
        decidedBy: input.decidedBy
      })
    : undefined
  const { outcome } = yield* approveApproval(
    dependencies,
    decision,
    rule === undefined ? "approved" : "approved_always",
    input.relay
  )
  return outcome
})

/** One decision applied to many calls; a call that cannot be decided is reported, not fatal. */
export const decideApprovals = Effect.fn("Approvals.decideMany")(function* (
  dependencies: Parameters<typeof approveApproval>[0],
  input: {
    readonly tenantId: TenantId
    readonly ids: ReadonlyArray<ApprovalId>
    readonly verdict: ApprovalVerdict
    readonly decidedBy: string | null
    readonly remember: boolean
  }
) {
  const rule =
    input.remember && input.verdict === "approve" ? yield* rememberApproval(dependencies.store, input) : undefined
  const results = yield* Effect.forEach(
    new Set(input.ids),
    (id) => {
      const decision = { tenantId: input.tenantId, id, decidedBy: input.decidedBy }
      const decided =
        input.verdict === "approve"
          ? Effect.map(
              approveApproval(dependencies, decision, rule === undefined ? "approved" : "approved_always"),
              ({ approval }) => approval
            )
          : Effect.map(denyApproval(dependencies.store, decision), ({ approval }) => approval)
      return decided.pipe(
        Effect.map((approval): DecidedApproval => ({ id, status: "decided", approval })),
        Effect.catchTags({
          ApprovalNotFound: (): Effect.Effect<DecidedApproval> =>
            Effect.succeed({ id, status: "refused", error: `Unknown approval ${id}` }),
          ApprovalConflict: ({ message }): Effect.Effect<DecidedApproval> =>
            Effect.succeed({ id, status: "refused", error: message }),
          ApprovalArgumentsInvalid: ({ message }): Effect.Effect<DecidedApproval> =>
            Effect.succeed({ id, status: "refused", error: message })
        })
      )
    },
    { concurrency: 4 }
  )
  return { results, ...whenPresent("rule", rule) }
})
