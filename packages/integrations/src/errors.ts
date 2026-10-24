import { Schema } from "effect"
import { OAuthFailureReason, UpstreamFailure } from "@integragents/contracts"

export class StorageError extends Schema.TaggedError<StorageError>()("StorageError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect())
}) {}

export const InvocationFailure = Schema.Literals([
  "unknown_argument",
  "missing_argument",
  "network",
  "timeout",
  "upstream_status",
  "tool_error"
])
export type InvocationFailure = typeof InvocationFailure.Type

/** A tool call that failed in its source. `detail` is bounded and never holds a credential. */
export class InvocationError extends Schema.TaggedError<InvocationError>()("InvocationError", {
  code: InvocationFailure,
  detail: Schema.String,
  status: Schema.optional(Schema.Number),
  /** The arguments a `unknown_argument` or `missing_argument` failure is about. */
  arguments: Schema.optional(Schema.Array(Schema.String)),
  /** The upstream's JSON error body, when it is small enough to pass on whole. */
  upstreamError: Schema.optional(Schema.Json)
}) {
  override get message(): string {
    return `${this.code}: ${this.detail}`
  }
}

export class SpecError extends Schema.TaggedError<SpecError>()("SpecError", {
  source: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect())
}) {
  override get message(): string {
    return `Could not load specification ${this.source}: ${this.detail}`
  }
}

/**
 * Why an MCP server could not be used. `refused` carries the server's own
 * answer to the request; every other reason is decided from status codes,
 * headers and error types, never from response text.
 */
export const McpFailureReason = UpstreamFailure
export type McpFailureReason = UpstreamFailure

export class McpError extends Schema.TaggedError<McpError>()("McpError", {
  endpoint: Schema.String,
  reason: McpFailureReason,
  detail: Schema.String,
  status: Schema.optional(Schema.Number),
  /** The scopes an `insufficient_scope` challenge said the call needs. */
  requiredScopes: Schema.optional(Schema.Array(Schema.String)),
  cause: Schema.optional(Schema.Defect())
}) {
  override get message(): string {
    return `MCP endpoint ${this.endpoint} failed: ${this.detail}`
  }
}

/** What went wrong, never the provider's response body, a token, or the request. */
export class OAuthError extends Schema.TaggedError<OAuthError>()("OAuthError", {
  stage: Schema.Literals(["discover", "register", "start", "complete", "refresh"]),
  reason: OAuthFailureReason,
  detail: Schema.String
}) {
  override get message(): string {
    return `OAuth ${this.stage} failed: ${this.detail}`
  }
}

const detailLimit = 400

export const describeCause = (cause: unknown): string => {
  const message = cause instanceof Error ? cause.message : String(cause)
  return message.length <= detailLimit
    ? message
    : `${message.slice(0, detailLimit)}… (${message.length} characters, truncated)`
}
