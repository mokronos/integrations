import { Schema } from "effect"

export class StorageError extends Schema.TaggedError<StorageError>()("StorageError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect())
}) {}

export class IntegrationNotFoundError extends Schema.TaggedError<IntegrationNotFoundError>()(
  "IntegrationNotFoundError",
  { integration: Schema.String }
) {
  override get message(): string {
    return `Integration not found: ${this.integration}`
  }
}

export class ConnectionNotFoundError extends Schema.TaggedError<ConnectionNotFoundError>()("ConnectionNotFoundError", {
  integration: Schema.String,
  connection: Schema.String
}) {
  override get message(): string {
    return `Connection not found: ${this.integration}/${this.connection}`
  }
}

export class ToolNotFoundError extends Schema.TaggedError<ToolNotFoundError>()("ToolNotFoundError", {
  tool: Schema.String
}) {
  override get message(): string {
    return `Tool not found: ${this.tool}`
  }
}

export class InvocationError extends Schema.TaggedError<InvocationError>()("InvocationError", {
  code: Schema.String,
  detail: Schema.String,
  status: Schema.optional(Schema.Number)
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
export const McpFailureReason = Schema.Literals([
  "unauthorized",
  "forbidden",
  "rate_limited",
  "refused",
  "rejected",
  "unavailable",
  "network",
  "timeout",
  "protocol"
])
export type McpFailureReason = typeof McpFailureReason.Type

export class McpError extends Schema.TaggedError<McpError>()("McpError", {
  endpoint: Schema.String,
  reason: McpFailureReason,
  detail: Schema.String,
  status: Schema.optional(Schema.Number),
  cause: Schema.optional(Schema.Defect())
}) {
  override get message(): string {
    return `MCP endpoint ${this.endpoint} failed: ${this.detail}`
  }
}

export const OAuthFailureReason = Schema.Literals([
  "request",
  "timeout",
  "destination_blocked",
  "metadata_missing",
  "invalid_response",
  "unsupported",
  "invalid_client",
  "invalid_grant",
  "invalid_scope",
  "denied",
  "invalid_callback",
  "not_pending",
  "reconnect_required"
])
export type OAuthFailureReason = typeof OAuthFailureReason.Type

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

export class DetectionError extends Schema.TaggedError<DetectionError>()("DetectionError", {
  url: Schema.String,
  detail: Schema.String
}) {
  override get message(): string {
    return `Could not detect an integration at ${this.url}: ${this.detail}`
  }
}

export class InvalidInputError extends Schema.TaggedError<InvalidInputError>()("InvalidInputError", {
  field: Schema.String,
  detail: Schema.String
}) {
  override get message(): string {
    return `Invalid ${this.field}: ${this.detail}`
  }
}

const detailLimit = 400

export const describeCause = (cause: unknown): string => {
  const message = cause instanceof Error ? cause.message : String(cause)
  return message.length <= detailLimit
    ? message
    : `${message.slice(0, detailLimit)}… (${message.length} characters, truncated)`
}
