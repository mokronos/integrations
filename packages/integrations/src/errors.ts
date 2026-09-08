import { Schema } from "effect"

export class StorageError extends Schema.TaggedError<StorageError>()(
  "StorageError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect())
  }
) {}

export class IntegrationNotFoundError extends Schema.TaggedError<IntegrationNotFoundError>()(
  "IntegrationNotFoundError",
  { integration: Schema.String }
) {
  override get message(): string {
    return `Integration not found: ${this.integration}`
  }
}

export class ConnectionNotFoundError extends Schema.TaggedError<ConnectionNotFoundError>()(
  "ConnectionNotFoundError",
  {
    integration: Schema.String,
    connection: Schema.String
  }
) {
  override get message(): string {
    return `Connection not found: ${this.integration}/${this.connection}`
  }
}

export class ToolNotFoundError extends Schema.TaggedError<ToolNotFoundError>()(
  "ToolNotFoundError",
  { tool: Schema.String }
) {
  override get message(): string {
    return `Tool not found: ${this.tool}`
  }
}

export class InvocationError extends Schema.TaggedError<InvocationError>()(
  "InvocationError",
  {
    code: Schema.String,
    detail: Schema.String,
    status: Schema.optional(Schema.Number)
  }
) {
  override get message(): string {
    return `${this.code}: ${this.detail}`
  }
}

export class SpecError extends Schema.TaggedError<SpecError>()(
  "SpecError",
  {
    source: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect())
  }
) {
  override get message(): string {
    return `Could not load specification ${this.source}: ${this.detail}`
  }
}

export class McpError extends Schema.TaggedError<McpError>()(
  "McpError",
  {
    endpoint: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect())
  }
) {
  override get message(): string {
    return `MCP endpoint ${this.endpoint} failed: ${this.detail}`
  }
}

export class OAuthError extends Schema.TaggedError<OAuthError>()(
  "OAuthError",
  {
    stage: Schema.Literals(["probe", "register", "start", "complete", "refresh"]),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect())
  }
) {
  override get message(): string {
    return `OAuth ${this.stage} failed: ${this.detail}`
  }
}

export class DetectionError extends Schema.TaggedError<DetectionError>()(
  "DetectionError",
  {
    url: Schema.String,
    detail: Schema.String
  }
) {
  override get message(): string {
    return `Could not detect an integration at ${this.url}: ${this.detail}`
  }
}

export class InvalidInputError extends Schema.TaggedError<InvalidInputError>()(
  "InvalidInputError",
  {
    field: Schema.String,
    detail: Schema.String
  }
) {
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
