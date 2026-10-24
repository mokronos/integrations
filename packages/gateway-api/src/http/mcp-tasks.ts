import { inputRequired, inputResponse, ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server"
import type { McpServer, ServerContext } from "@modelcontextprotocol/server"
import { Effect, Option, Schema } from "effect"
import { Alias, ApprovalId, asJson, NotFound } from "@integragents/contracts"
import type { GatewayError, PendingApproval } from "@integragents/contracts"
import { approvalOutcome } from "@integragents/gateway-core"
import { outcomeResult } from "./mcp-results.ts"
import { approvalForm, approvalMessage, decideInClient, decodeApprovalAnswer } from "./mcp-tools.ts"
import type { McpCaller } from "./mcp-tools.ts"
import { findProfileApproval, invokeDependencies } from "./operations.ts"
import type { GatewayOperationServices } from "./operations.ts"

/**
 * A call held for a human is a task (MCP Tasks extension) for a client that
 * says it can poll one: `tools/call` answers at once with the approval as a
 * task, and `tasks/get` reports it until the human decides and the call runs.
 * The task's id is the approval's, so no other state is kept.
 */
export const tasksExtension = "io.modelcontextprotocol/tasks"

const pollIntervalMs = 5_000

/** Unique per task, as the extension requires of every input request key. */
const approvalKeyOf = (id: ApprovalId): string => `integrations/approval/${id}`

const TaskParams = Schema.Struct({ taskId: Schema.String })
const Acknowledged = Schema.Struct({})

/** A task as the extension's `tasks/get` reports it, its status's own fields inlined. */
const McpTask = Schema.Struct({
  taskId: Schema.String,
  status: Schema.Literals(["working", "input_required", "completed", "failed", "cancelled"]),
  statusMessage: Schema.optional(Schema.String),
  createdAt: Schema.String,
  lastUpdatedAt: Schema.String,
  ttlMs: Schema.NullOr(Schema.Number),
  pollIntervalMs: Schema.optional(Schema.Number),
  inputRequests: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
  result: Schema.optional(Schema.Json)
})
type McpTask = typeof McpTask.Type

const standard = <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S) =>
  Schema.toStandardSchemaV1(Schema.toCodecJson(schema))

const base = (approval: PendingApproval) => ({
  taskId: approval.id,
  createdAt: approval.createdAt.toISOString(),
  lastUpdatedAt: (approval.decidedAt ?? approval.createdAt).toISOString(),
  ttlMs: approval.expiresAt === null ? null : approval.expiresAt.getTime() - approval.createdAt.getTime(),
  pollIntervalMs
})

/** What `tasks/get` says of an approval, given what the asking client can put to its human. */
export const taskOf = (
  caller: McpCaller,
  approval: PendingApproval
): Effect.Effect<McpTask, never, GatewayOperationServices> =>
  Effect.gen(function* () {
    switch (approval.status) {
      case "pending": {
        if (caller.profile.approvalMethod === "elicitation" && caller.elicitation.form) {
          const request = inputRequired.elicit({
            message: approvalMessage({
              alias: Alias.make(approval.alias),
              tool: approval.tool,
              arguments: approval.arguments
            }),
            requestedSchema: approvalForm
          })
          return {
            ...base(approval),
            status: "input_required",
            statusMessage: "Waiting for a human to approve the call.",
            inputRequests: { [approvalKeyOf(approval.id)]: asJson(request) }
          }
        }
        const dependencies = yield* invokeDependencies
        const link = caller.profile.approvalMethod === "none" ? undefined : dependencies.approvalUrlOf?.(approval.id)
        return {
          ...base(approval),
          status: "working",
          statusMessage:
            link === undefined
              ? "Waiting for a human to approve the call."
              : `Waiting for a human to approve the call at ${link}.`
        }
      }
      case "executing":
        return { ...base(approval), status: "working", statusMessage: "Approved; the call is running." }
      case "approved":
      case "denied":
      case "expired": {
        const outcome = approvalOutcome(approval)
        if (outcome === undefined) return { ...base(approval), status: "working" }
        const result = yield* outcomeResult(Alias.make(approval.alias), outcome)
        return { ...base(approval), status: "completed", result: asJson(result) }
      }
    }
  })

const missingCapability = () =>
  new ProtocolError(ProtocolErrorCode.MissingRequiredClientCapability, "Missing required client capability", {
    requiredCapabilities: { extensions: { [tasksExtension]: {} } }
  })

export type TaskRun = <A>(
  effect: Effect.Effect<A, GatewayError, GatewayOperationServices>,
  context: ServerContext
) => Promise<A>

/**
 * Serves `tasks/get`, `tasks/update` and `tasks/cancel` over the profile's
 * approvals. Every request is checked against the profile asking, so a task
 * id from another profile reads as unknown.
 */
export const serveTasks = (server: McpServer, run: TaskRun, callerOf: (context: ServerContext) => McpCaller): void => {
  const approvalFor = (caller: McpCaller, taskId: string) =>
    Effect.flatMap(findProfileApproval(caller.profile, ApprovalId.make(taskId)), (approval) =>
      approval === undefined
        ? Effect.fail(new NotFound({ resource: "approval", id: taskId }))
        : Effect.succeed(approval)
    )
  const callerWithTasks = (context: ServerContext): McpCaller => {
    const caller = callerOf(context)
    if (!caller.tasks) throw missingCapability()
    return caller
  }

  server.server.setRequestHandler(
    "tasks/get",
    { params: standard(TaskParams), result: standard(McpTask) },
    async ({ taskId }, context) => {
      const caller = callerWithTasks(context)
      return run(
        Effect.flatMap(approvalFor(caller, taskId), (approval) => taskOf(caller, approval)),
        context
      )
    }
  )

  server.server.setRequestHandler(
    "tasks/update",
    { params: standard(TaskParams), result: standard(Acknowledged) },
    /** The SDK lifts a request's `inputResponses` out of its params, as it does for every multi round-trip answer. */
    async ({ taskId }, context) => {
      const caller = callerWithTasks(context)
      return run(
        Effect.gen(function* () {
          const approval = yield* approvalFor(caller, taskId)
          if (approval.status !== "pending") return {}
          const answer = inputResponse(context.mcpReq.inputResponses, approvalKeyOf(approval.id))
          if (answer.kind !== "elicit" || answer.action === "cancel") return {}
          const accepted = answer.action === "accept"
          const remember = accepted
            ? Option.exists(decodeApprovalAnswer(answer.content ?? {}), (content) => content.remember === true)
            : false
          yield* decideInClient(caller, { approvalId: approval.id, accepted, remember })
          return {}
        }),
        context
      )
    }
  )

  server.server.setRequestHandler(
    "tasks/cancel",
    { params: standard(TaskParams), result: standard(Acknowledged) },
    async ({ taskId }, context) => {
      const caller = callerWithTasks(context)
      return run(
        Effect.gen(function* () {
          const approval = yield* approvalFor(caller, taskId)
          if (approval.status === "pending") {
            yield* decideInClient(caller, {
              approvalId: approval.id,
              accepted: false,
              remember: false,
              how: "withdrawn by the client"
            })
          }
          return {}
        }),
        context
      )
    }
  )
}
