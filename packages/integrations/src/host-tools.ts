import { Context, Effect, Layer, Schema } from "effect"
import {
  ApprovalId,
  ConnectionName,
  IntegrationSlug,
  ProfileId,
  SubjectId,
  TenantId,
  ToolAddress,
  ToolName
} from "@integragents/contracts"

type Json = typeof Schema.Json.Type

/** One tool the embedding host runs itself, described the way a catalog describes any other tool. */
export const HostToolDefinition = Schema.Struct({
  name: ToolName,
  description: Schema.String,
  inputSchema: Schema.optional(Schema.Json),
  outputSchema: Schema.optional(Schema.Json),
  /** What the host's executor dispatches on; the tool's name when absent. */
  handler: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
  /** Only reads, so the default decision lets it run. Absent means it writes. */
  readOnly: Schema.optional(Schema.Boolean),
  /** May destroy or overwrite. Absent means it may, unless it only reads. */
  destructive: Schema.optional(Schema.Boolean),
  /** Repeating it with the same arguments has no further effect. Absent means it is not, unless it only reads. */
  idempotent: Schema.optional(Schema.Boolean)
})
export type HostToolDefinition = typeof HostToolDefinition.Type

/**
 * An integration whose tools the embedding host executes, such as running a
 * command in a user's sandbox. It is catalogued like any other integration, on
 * one org connection that holds no credential, so profiles, decisions,
 * approvals and audit treat its tools exactly as they treat MCP and OpenAPI
 * tools.
 */
export const HostIntegrationDefinition = Schema.Struct({
  slug: IntegrationSlug,
  name: Schema.String,
  description: Schema.optional(Schema.String),
  /** The org connection the tools live on; `default` when absent. */
  connection: Schema.optional(ConnectionName),
  tools: Schema.Array(HostToolDefinition)
})
export type HostIntegrationDefinition = typeof HostIntegrationDefinition.Type

/** Who a call is made for, as far as the caller of `execute` knows it. Host tools receive it; others ignore it. */
export interface ToolCallContext {
  readonly tenantId?: TenantId
  readonly profileId?: ProfileId
  /** The person the call acts for, when the invocation named one. */
  readonly subject?: SubjectId
  /** The approval a human or reviewer gave before the call ran. */
  readonly approvalId?: ApprovalId
  /** The caller's key for this call, stable across its retries. */
  readonly idempotencyKey?: string
}

export interface HostToolInvocation {
  readonly address: ToolAddress
  readonly integration: IntegrationSlug
  readonly connection: ConnectionName
  readonly tool: ToolName
  readonly handler: string
  readonly arguments: Json
  readonly context: ToolCallContext
}

/** The host could not run the tool; the message reaches the caller and the audit trail. */
export class HostToolError extends Schema.TaggedError<HostToolError>()("HostToolError", {
  handler: Schema.String,
  detail: Schema.String
}) {
  override get message(): string {
    return `${this.handler}: ${this.detail}`
  }
}

/** Runs the tools of host integrations. Without it, calling one fails rather than doing nothing. */
export class HostTools extends Context.Service<
  HostTools,
  {
    readonly execute: (invocation: HostToolInvocation) => Effect.Effect<Json, HostToolError>
  }
>()("@integragents/host/HostTools") {
  static readonly layer = (executor: HostTools["Service"]): Layer.Layer<HostTools> => Layer.succeed(HostTools, executor)
}
