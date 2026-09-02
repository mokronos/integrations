import { Schema } from "effect"

/** Every failure the integration host can produce, as serializable tagged
 *  errors. These replace the SDK's error classes; the gateway pattern-matches
 *  on `_tag` rather than on message text. */

/** Persistence failed — the database or the credential file, not the caller. */
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

/** The integration was reached and refused the call, or the transport failed.
 *  `status` is present when the upstream spoke HTTP. */
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

/** An OpenAPI or Google Discovery document could not be fetched, parsed, or
 *  projected into tools. */
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

/** An MCP endpoint could not be reached, initialized, or queried. */
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

/** Discovery, registration, or a token exchange failed. Distinct from
 *  `InvocationError` because the remedy is re-authorization, not a retry. */
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

/** The endpoint could not be classified as either MCP or OpenAPI. */
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

/** A caller supplied something the host cannot act on — a malformed slug, an
 *  auth template the integration does not declare. */
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


/** Narrows a caught defect to a readable sentence without leaking a stack into
 *  an error field that is rendered to a human. */
/** How much of a failure's message is worth carrying.
 *
 *  A vendor's error body can be its whole catalogue. Google answers a bearer
 *  token it does not accept with HTTP 401 and a complete, valid `tools/list`
 *  result, and the MCP SDK puts that body verbatim into the error it throws.
 *  Fifty kilobytes of tool schemas in a "could not connect" message tells a
 *  reader nothing the first line did not, and buries the line that does. */
const detailLimit = 400

export const describeCause = (cause: unknown): string => {
  const message = cause instanceof Error ? cause.message : String(cause)
  return message.length <= detailLimit
    ? message
    : `${message.slice(0, detailLimit)}… (${message.length} characters, truncated)`
}
