import { Option, Predicate, Schema, SchemaAST, SchemaGetter, SchemaIssue } from "effect"
import type { HttpClientError } from "effect/http"
import { ProfileCapability } from "./vocabulary.ts"

/**
 * Every failure a gateway caller can receive. Each class carries the fields
 * that explain it, its HTTP status, and the `message`, `hint` and `retryable`
 * derived from those fields. The derived values are encoded for callers that
 * read raw JSON and recomputed on decode, so every surface shows the same text.
 */

const DerivedMessage = Schema.String.pipe(
  Schema.decodeTo(Schema.optionalKey(Schema.String), {
    decode: SchemaGetter.omit(),
    encode: SchemaGetter.passthrough()
  })
)

const DerivedHint = Schema.optionalKey(Schema.String).pipe(
  Schema.decodeTo(Schema.optional(Schema.String), {
    decode: SchemaGetter.omit(),
    encode: SchemaGetter.transformOptional((hint: Option.Option<string | undefined>) =>
      Option.filter(hint, Predicate.isNotUndefined)
    )
  })
)

const DerivedFlag = Schema.Boolean.pipe(
  Schema.decodeTo(Schema.optionalKey(Schema.Boolean), {
    decode: SchemaGetter.omit(),
    encode: SchemaGetter.passthrough()
  })
)

const presented = { message: DerivedMessage, hint: DerivedHint, retryable: DerivedFlag }

export const Issue = Schema.Struct({ path: Schema.String, message: Schema.String })
export type Issue = typeof Issue.Type

const standardIssues = SchemaIssue.makeFormatterStandardSchemaV1()

const pathOf = (path: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined): string =>
  path === undefined || path.length === 0
    ? "(root)"
    : path.map((segment) => String(Predicate.isObject(segment) ? segment.key : segment)).join(".")

/** Each place a value failed its schema, by path. */
export const schemaIssues = (error: Schema.SchemaError): ReadonlyArray<Issue> =>
  standardIssues(error.issue).issues.map((issue) => ({ path: pathOf(issue.path), message: issue.message }))

/** The request does not fit what the gateway accepts; `field` names the input to change. */
export class InvalidInput extends Schema.TaggedError<InvalidInput>()(
  "InvalidInput",
  {
    field: Schema.String,
    problem: Schema.String,
    issues: Schema.optional(Schema.Array(Issue)),
    ...presented
  },
  { httpApiStatus: 400 }
) {
  override get message(): string {
    return `Invalid ${this.field}: ${this.problem}`
  }
  override get hint(): string | undefined {
    return this.issues === undefined || this.issues.length < 2
      ? undefined
      : this.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")
  }
  override get retryable(): boolean {
    return false
  }

  /** `field` failed to decode; the first issue becomes the problem, all of them the issues. */
  static fromSchemaError(field: string, error: Schema.SchemaError): InvalidInput {
    const issues = schemaIssues(error)
    const first = issues[0]
    return new InvalidInput({
      field,
      problem: first === undefined ? "it does not have the expected shape" : `${first.path}: ${first.message}`,
      issues
    })
  }
}

export const Resource = Schema.Literals([
  "integration",
  "connection",
  "tool",
  "auth-template",
  "profile",
  "approval",
  "approval-rule",
  "approval-destination",
  "subject",
  "api-key",
  "blob",
  "oauth-session",
  "oauth-request",
  "oauth-application",
  "oauth-grant",
  "route"
])
export type Resource = typeof Resource.Type

const lookupHints: ReadonlyMap<Resource, string> = new Map([
  ["integration", "Search the registry for it, or register it by URL with discover"],
  ["connection", "Connect the integration first"],
  ["tool", "List the tools to see what is available"],
  ["oauth-session", "Start the authorization again"],
  ["route", "Check the method and path"]
])

export class NotFound extends Schema.TaggedError<NotFound>()(
  "NotFound",
  {
    resource: Resource,
    id: Schema.String,
    /** What does exist in its place, so a typo can be corrected. */
    known: Schema.optional(Schema.Array(Schema.String)),
    ...presented
  },
  { httpApiStatus: 404 }
) {
  override get message(): string {
    return `Unknown ${this.resource} ${this.id}`
  }
  override get hint(): string | undefined {
    if (this.known !== undefined) {
      return this.known.length === 0 ? `There is no ${this.resource} yet` : `Known: ${this.known.join(", ")}`
    }
    return lookupHints.get(this.resource)
  }
  override get retryable(): boolean {
    return false
  }
}

export class AlreadyExists extends Schema.TaggedError<AlreadyExists>()(
  "AlreadyExists",
  {
    resource: Schema.Literals(["account", "profile", "subject"]),
    id: Schema.String,
    ...presented
  },
  { httpApiStatus: 409 }
) {
  override get message(): string {
    return this.resource === "account"
      ? `An account for ${this.id} already exists`
      : `A ${this.resource} named ${this.id} already exists`
  }
  override get hint(): string | undefined {
    return this.resource === "account" ? "Sign in instead" : "Pick another name"
  }
  override get retryable(): boolean {
    return false
  }
}

export class ApprovalConflict extends Schema.TaggedError<ApprovalConflict>()(
  "ApprovalConflict",
  {
    approval: Schema.optional(Schema.String),
    state: Schema.Literals(["decided", "expired", "unauthorized", "none-waiting", "mixed"]),
    ...presented
  },
  { httpApiStatus: 409 }
) {
  override get message(): string {
    const approval = this.approval === undefined ? "The approval" : `Approval ${this.approval}`
    switch (this.state) {
      case "decided":
        return `${approval} has already been decided`
      case "expired":
        return `${approval} expired`
      case "unauthorized":
        return `${approval} is no longer authorized: its profile no longer enables the tool`
      case "none-waiting":
        return "None of these calls is still waiting for a decision"
      case "mixed":
        return "A saved approval covers one tool of one profile; these calls span several"
    }
  }
  override get hint(): string | undefined {
    return this.state === "mixed" ? "Decide the calls separately" : "Reload the approvals to see their current state"
  }
  override get retryable(): boolean {
    return false
  }
}

export class ProfileRevoked extends Schema.TaggedError<ProfileRevoked>()(
  "ProfileRevoked",
  { profile: Schema.String, ...presented },
  { httpApiStatus: 409 }
) {
  override get message(): string {
    return `Profile ${this.profile} is revoked`
  }
  override get hint(): string | undefined {
    return "Create a new profile instead"
  }
  override get retryable(): boolean {
    return false
  }
}

export class MethodNotAllowed extends Schema.TaggedError<MethodNotAllowed>()(
  "MethodNotAllowed",
  { method: Schema.String, path: Schema.String, ...presented },
  { httpApiStatus: 405 }
) {
  override get message(): string {
    return `${this.method} is not allowed on ${this.path}`
  }
  override get hint(): string | undefined {
    return undefined
  }
  override get retryable(): boolean {
    return false
  }
}

export class PayloadTooLarge extends Schema.TaggedError<PayloadTooLarge>()(
  "PayloadTooLarge",
  { limitBytes: Schema.Number, ...presented },
  { httpApiStatus: 413 }
) {
  override get message(): string {
    return `Request body exceeds ${this.limitBytes} bytes`
  }
  override get hint(): string | undefined {
    return "Upload large content to POST /v1/blobs and pass the blob handle instead"
  }
  override get retryable(): boolean {
    return false
  }
}

export const UnauthorizedCode = Schema.Literals([
  "missing-credential",
  "unknown-key",
  "key-revoked",
  "session-expired",
  "invalid-token"
])
export type UnauthorizedCode = typeof UnauthorizedCode.Type

/** The gateway does not know who is calling. */
export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  "Unauthorized",
  { code: UnauthorizedCode, ...presented },
  { httpApiStatus: 401 }
) {
  override get message(): string {
    switch (this.code) {
      case "missing-credential":
        return "No credential was presented"
      case "unknown-key":
        return "This API key is not known to the gateway"
      case "key-revoked":
        return "This API key was revoked"
      case "session-expired":
        return "Your session has expired"
      case "invalid-token":
        return "This access token is invalid or expired"
    }
  }
  override get hint(): string | undefined {
    switch (this.code) {
      case "missing-credential":
        return "Pass an API key as a bearer token, or sign in"
      case "unknown-key":
        return "Check the API key you configured (INTEGRATIONS_API_KEY)"
      case "key-revoked":
        return "Ask an operator for a new key"
      case "session-expired":
        return "Sign in again"
      case "invalid-token":
        return "Authorize the client again"
    }
  }
  override get retryable(): boolean {
    return false
  }
}

/** The gateway knows the caller, and the caller may not do this. */
export class Forbidden extends Schema.TaggedError<Forbidden>()(
  "Forbidden",
  {
    code: Schema.Literals(["profile-revoked", "not-permitted", "cross-site"]),
    /** The capability the request needs, when a profile capability is what is missing. */
    capability: Schema.optional(ProfileCapability),
    ...presented
  },
  { httpApiStatus: 403 }
) {
  override get message(): string {
    switch (this.code) {
      case "profile-revoked":
        return "The profile this credential belongs to was revoked"
      case "not-permitted":
        return this.capability === undefined
          ? "This credential may not make this request"
          : `This credential's profile lacks the ${this.capability} capability`
      case "cross-site":
        return "Cross-site requests are not permitted"
    }
  }
  override get hint(): string | undefined {
    switch (this.code) {
      case "profile-revoked":
        return "Ask an operator for a key of an active profile"
      case "not-permitted":
        return this.capability === undefined
          ? "Use a credential that is allowed to make this request"
          : `Use a key of a profile with ${this.capability}, or a human session`
      case "cross-site":
        return "Call the gateway from its own origin"
    }
  }
  override get retryable(): boolean {
    return false
  }
}

export class RateLimited extends Schema.TaggedError<RateLimited>()(
  "RateLimited",
  { retryAfterSeconds: Schema.Number, ...presented },
  { httpApiStatus: 429 }
) {
  override get message(): string {
    return "Too many requests"
  }
  override get hint(): string | undefined {
    return `Retry in ${this.retryAfterSeconds} seconds`
  }
  override get retryable(): boolean {
    return true
  }
}

export class InvalidCredentials extends Schema.TaggedError<InvalidCredentials>()(
  "InvalidCredentials",
  { ...presented },
  { httpApiStatus: 401 }
) {
  override get message(): string {
    return "The email or password is wrong"
  }
  override get hint(): string | undefined {
    return undefined
  }
  override get retryable(): boolean {
    return false
  }
}

export class SignupClosed extends Schema.TaggedError<SignupClosed>()(
  "SignupClosed",
  { ...presented },
  { httpApiStatus: 403 }
) {
  override get message(): string {
    return "Signup is closed on this gateway"
  }
  override get hint(): string | undefined {
    return "Sign in with an existing account, or ask an operator to invite you"
  }
  override get retryable(): boolean {
    return false
  }
}

export class PasswordRequired extends Schema.TaggedError<PasswordRequired>()(
  "PasswordRequired",
  { ...presented },
  { httpApiStatus: 409 }
) {
  override get message(): string {
    return "This account has no password yet"
  }
  override get hint(): string | undefined {
    return "Set a password first"
  }
  override get retryable(): boolean {
    return false
  }
}

export class LoginHandoffFailed extends Schema.TaggedError<LoginHandoffFailed>()(
  "LoginHandoffFailed",
  { state: Schema.Literals(["unknown", "expired", "collected"]), ...presented },
  { httpApiStatus: 410 }
) {
  override get message(): string {
    switch (this.state) {
      case "unknown":
        return "This sign-in request is unknown"
      case "expired":
        return "This sign-in request expired"
      case "collected":
        return "This sign-in request was already used"
    }
  }
  override get hint(): string | undefined {
    return "Start the sign-in again"
  }
  override get retryable(): boolean {
    return false
  }
}

export class NotImplemented extends Schema.TaggedError<NotImplemented>()(
  "NotImplemented",
  {
    feature: Schema.String,
    /** Another way to get the same thing done, when there is one. */
    alternative: Schema.optional(Schema.String),
    ...presented
  },
  { httpApiStatus: 501 }
) {
  override get message(): string {
    return `${this.feature} is not available on this gateway`
  }
  override get hint(): string | undefined {
    return this.alternative
  }
  override get retryable(): boolean {
    return false
  }
}

/** A failure inside the gateway; only the trace id leaves it, and it finds the spans and logs. */
export class GatewayFailure extends Schema.TaggedError<GatewayFailure>()(
  "GatewayFailure",
  { traceId: Schema.String, ...presented },
  { httpApiStatus: 500 }
) {
  override get message(): string {
    return "The gateway could not complete this request"
  }
  override get hint(): string | undefined {
    return `Retry; if it keeps failing, give trace ${this.traceId} to the gateway's operator`
  }
  override get retryable(): boolean {
    return true
  }
}

export const DiscoveryFailure = Schema.Literals(["no-scheme", "unsupported-scheme", "unreachable", "not-recognized"])

/** A URL that is neither an MCP endpoint nor an OpenAPI document the gateway could read. */
export class DiscoveryFailed extends Schema.TaggedError<DiscoveryFailed>()(
  "DiscoveryFailed",
  {
    url: Schema.String,
    reason: DiscoveryFailure,
    /** Why it is not an MCP endpoint, when that was probed. */
    mcp: Schema.optional(Schema.String),
    /** Why it is not an OpenAPI document, when that was probed. */
    openapi: Schema.optional(Schema.String),
    ...presented
  },
  { httpApiStatus: 422 }
) {
  override get message(): string {
    switch (this.reason) {
      case "no-scheme":
        return `${this.url} has no http:// or https:// scheme`
      case "unsupported-scheme":
        return `${this.url} is not an http:// or https:// URL`
      case "unreachable":
        return `${this.url} could not be reached (${this.mcp ?? "no answer"})`
      case "not-recognized":
        return `${this.url} is not an MCP endpoint (${this.mcp ?? "not probed"}) and not an OpenAPI document (${this.openapi ?? "not probed"})`
    }
  }
  override get hint(): string | undefined {
    switch (this.reason) {
      case "no-scheme":
        return `Did you mean https://${this.url}?`
      case "unsupported-scheme":
        return "Pass an http:// or https:// URL"
      case "unreachable":
        return "Check the URL, and that the server is up and reachable from the gateway"
      case "not-recognized":
        return "Pass the MCP endpoint or the OpenAPI document's own URL, not a documentation page"
    }
  }
  override get retryable(): boolean {
    return false
  }
}

export class SpecInvalid extends Schema.TaggedError<SpecInvalid>()(
  "SpecInvalid",
  { source: Schema.String, detail: Schema.String, ...presented },
  { httpApiStatus: 422 }
) {
  override get message(): string {
    return `Could not read the specification ${this.source}: ${this.detail}`
  }
  override get hint(): string | undefined {
    return "Check that the URL serves a valid OpenAPI or Google Discovery document"
  }
  override get retryable(): boolean {
    return false
  }
}

export const UpstreamFailure = Schema.Literals([
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
export type UpstreamFailure = typeof UpstreamFailure.Type

const transient = (reason: UpstreamFailure | ToolCallFailure): boolean =>
  reason === "rate_limited" || reason === "unavailable" || reason === "network" || reason === "timeout"

const upstreamHint = (reason: UpstreamFailure): string | undefined => {
  switch (reason) {
    case "unauthorized":
      return "Connect it with a credential the server accepts"
    case "forbidden":
      return "Connect it with a credential that holds the permission this needs"
    case "rate_limited":
      return "Wait, then try again"
    case "unavailable":
    case "timeout":
      return "Try again later"
    case "network":
      return "Check the URL and that the server is reachable from the gateway"
    case "protocol":
      return "Check that the URL is the server's MCP endpoint"
    case "refused":
    case "rejected":
      return undefined
  }
}

/** An MCP server the gateway talked to on the caller's behalf, outside of a tool call. */
export class McpServerFailed extends Schema.TaggedError<McpServerFailed>()(
  "McpServerFailed",
  {
    endpoint: Schema.String,
    reason: UpstreamFailure,
    status: Schema.optional(Schema.Number),
    detail: Schema.String,
    ...presented
  },
  { httpApiStatus: 502 }
) {
  override get message(): string {
    return `MCP server ${this.endpoint} failed: ${this.detail}`
  }
  override get hint(): string | undefined {
    return upstreamHint(this.reason)
  }
  override get retryable(): boolean {
    return transient(this.reason)
  }
}

export class RegistryUnavailable extends Schema.TaggedError<RegistryUnavailable>()(
  "RegistryUnavailable",
  {
    reason: Schema.Literals(["unreachable", "status", "unreadable"]),
    status: Schema.optional(Schema.Number),
    ...presented
  },
  { httpApiStatus: 502 }
) {
  override get message(): string {
    switch (this.reason) {
      case "unreachable":
        return "The integration registry could not be reached"
      case "status":
        return `The integration registry answered HTTP ${this.status ?? "error"}`
      case "unreadable":
        return "The integration registry's answer was unreadable"
    }
  }
  override get hint(): string | undefined {
    return "Try again later, or register the integration by URL with discover"
  }
  override get retryable(): boolean {
    return this.reason !== "unreadable"
  }
}

export const OAuthStage = Schema.Literals([
  "configure",
  "discover",
  "register",
  "start",
  "callback",
  "exchange",
  "refresh"
])
export type OAuthStage = typeof OAuthStage.Type

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
  "reconnect_required",
  "client_required"
])
export type OAuthFailureReason = typeof OAuthFailureReason.Type

/** An OAuth flow for a connection that could not finish. `detail` never holds a token or a response body. */
export class OAuthFailed extends Schema.TaggedError<OAuthFailed>()(
  "OAuthFailed",
  {
    integration: Schema.String,
    stage: OAuthStage,
    reason: OAuthFailureReason,
    detail: Schema.String,
    ...presented
  },
  { httpApiStatus: 502 }
) {
  override get message(): string {
    return `OAuth for ${this.integration} failed at ${this.stage}: ${this.detail}`
  }
  override get hint(): string | undefined {
    switch (this.reason) {
      case "invalid_client":
        return "Check the client ID and secret registered at the provider, and that its redirect URI matches the gateway's callback"
      case "client_required":
        return "Register an OAuth client at the provider and pass its client ID"
      case "denied":
        return "The account owner declined; start again and approve the request"
      case "invalid_scope":
        return "The provider refused the requested scopes; check what the OAuth client may request"
      case "timeout":
      case "invalid_grant":
      case "invalid_callback":
      case "not_pending":
        return "Start the authorization again and finish it in the browser"
      case "reconnect_required":
        return "Connect the integration again"
      case "metadata_missing":
      case "unsupported":
        return "The provider does not publish what this OAuth flow needs; connect with an API key or a manually registered client"
      case "destination_blocked":
        return "The provider's OAuth endpoints are not public HTTPS URLs the gateway may call"
      case "request":
      case "invalid_response":
        return "Try again later"
    }
  }
  override get retryable(): boolean {
    return this.reason === "request" || this.reason === "invalid_response"
  }
}

/** A connection whose authorization lapsed: refreshing it was refused, so a person has to authorize it again. */
export class OAuthReconnectRequired extends Schema.TaggedError<OAuthReconnectRequired>()(
  "OAuthReconnectRequired",
  { integration: Schema.String, connection: Schema.String, ...presented },
  { httpApiStatus: 409 }
) {
  override get message(): string {
    return `${this.integration}/${this.connection} must be authorized again`
  }
  override get hint(): string | undefined {
    return `Connect ${this.integration} again${this.connection === "default" ? "" : ` as ${this.connection}`}`
  }
  override get retryable(): boolean {
    return false
  }
}

export const ToolCallFailure = Schema.Literals([
  "unauthorized",
  "forbidden",
  "rate_limited",
  "refused",
  "rejected",
  "unavailable",
  "network",
  "timeout",
  "protocol",
  "tool_error"
])
export type ToolCallFailure = typeof ToolCallFailure.Type

/** A tool call the upstream did not complete. */
export class ToolCallFailed extends Schema.TaggedError<ToolCallFailed>()(
  "ToolCallFailed",
  {
    tool: Schema.String,
    reason: ToolCallFailure,
    detail: Schema.String,
    upstreamStatus: Schema.optional(Schema.Number),
    /** The upstream's JSON error body, when it is small enough to pass on whole. */
    upstreamError: Schema.optional(Schema.Json),
    /** The request reached the upstream and is not read-only, so it may have changed something before failing. */
    mayHaveWritten: Schema.Boolean,
    ...presented
  },
  { httpApiStatus: 502 }
) {
  override get message(): string {
    return `${this.tool} failed: ${this.detail}`
  }
  override get hint(): string | undefined {
    if (this.mayHaveWritten && this.reason !== "rejected" && this.reason !== "refused") {
      return "The call may have taken effect; check before repeating it"
    }
    switch (this.reason) {
      case "unauthorized":
        return "The connection's credential was rejected; connect the integration again"
      case "forbidden":
        return "The connection's credential lacks a permission this tool needs; connect again with it"
      case "rate_limited":
        return "Wait, then call again"
      case "unavailable":
      case "network":
      case "timeout":
        return "Call again later"
      case "refused":
      case "rejected":
      case "tool_error":
        return "Change the arguments according to the error, then call again"
      case "protocol":
        return "The upstream answered something unusable; report it to the integration's maintainer"
    }
  }
  override get retryable(): boolean {
    return !this.mayHaveWritten && transient(this.reason)
  }
}

/** The gateway is not answering; raised by clients, never sent by a gateway. */
export class GatewayUnavailable extends Schema.TaggedError<GatewayUnavailable>()(
  "GatewayUnavailable",
  { url: Schema.String, detail: Schema.String, ...presented },
  { httpApiStatus: 503 }
) {
  override get message(): string {
    return `Gateway at ${this.url} is unavailable: ${this.detail}`
  }
  override get hint(): string | undefined {
    return "Start the gateway (ii serve), or check INTEGRATIONS_URL"
  }
  override get retryable(): boolean {
    return true
  }
}

/** The gateway speaks another protocol version than this client; raised by clients. */
export class GatewayIncompatible extends Schema.TaggedError<GatewayIncompatible>()(
  "GatewayIncompatible",
  { expected: Schema.Number, received: Schema.optional(Schema.Number), ...presented },
  { httpApiStatus: 426 }
) {
  override get message(): string {
    return `Incompatible gateway protocol: this client requires ${this.expected}, the gateway reported ${this.received ?? "none"}`
  }
  override get hint(): string | undefined {
    return "Update the client or the gateway so their versions match"
  }
  override get retryable(): boolean {
    return false
  }
}

/** A response no contract describes, such as a proxy's error page; raised by clients. */
export class UnexpectedResponse extends Schema.TaggedError<UnexpectedResponse>()(
  "UnexpectedResponse",
  { method: Schema.String, url: Schema.String, status: Schema.optional(Schema.Number), ...presented },
  { httpApiStatus: 502 }
) {
  override get message(): string {
    return `${this.method} ${this.url} answered ${this.status === undefined ? "something" : `HTTP ${this.status}`} the client does not understand`
  }
  override get hint(): string | undefined {
    return "Check that INTEGRATIONS_URL points at the gateway itself and not at a proxy or another service"
  }
  override get retryable(): boolean {
    return this.status !== undefined && this.status >= 500
  }
}

/** What working with integrations can fail with: discovering, connecting, describing, and calling them. */
export const IntegrationError = Schema.Union([
  InvalidInput,
  NotFound,
  DiscoveryFailed,
  SpecInvalid,
  McpServerFailed,
  RegistryUnavailable,
  OAuthFailed,
  OAuthReconnectRequired,
  ToolCallFailed
])
export type IntegrationError = typeof IntegrationError.Type

export const GatewayError = Schema.Union([
  InvalidInput,
  NotFound,
  AlreadyExists,
  ApprovalConflict,
  ProfileRevoked,
  MethodNotAllowed,
  PayloadTooLarge,
  Unauthorized,
  Forbidden,
  RateLimited,
  InvalidCredentials,
  SignupClosed,
  PasswordRequired,
  LoginHandoffFailed,
  NotImplemented,
  GatewayFailure,
  DiscoveryFailed,
  SpecInvalid,
  McpServerFailed,
  RegistryUnavailable,
  OAuthFailed,
  OAuthReconnectRequired,
  ToolCallFailed,
  GatewayUnavailable,
  GatewayIncompatible,
  UnexpectedResponse
])
export type GatewayError = typeof GatewayError.Type
export const isGatewayError = Schema.is(GatewayError)

/**
 * What the caller has to do: change the request, change the credential, wait,
 * read what the service behind the gateway said, or tell an operator.
 */
export type ErrorCategory = "input" | "auth" | "unavailable" | "upstream" | "internal"

export interface ErrorPresentation {
  readonly code: GatewayError["_tag"]
  readonly status: number
  readonly message: string
  readonly hint: string | undefined
  readonly retryable: boolean
  readonly category: ErrorCategory
  readonly traceId: string | undefined
  readonly field: string | undefined
  readonly issues: ReadonlyArray<Issue>
}

const statusOf = (error: GatewayError): number => {
  const schema = GatewayError.members.find((member) => Schema.is(member)(error))
  return (schema === undefined ? undefined : SchemaAST.resolveAt<number>("httpApiStatus")(schema.ast)) ?? 500
}

const categoryOf = (error: GatewayError, status: number): ErrorCategory => {
  if (status === 401 || status === 403 || error._tag === "OAuthReconnectRequired") return "auth"
  if (error.retryable) return "unavailable"
  if (status === 502) return "upstream"
  if ((status >= 400 && status < 500) || status === 501) return "input"
  return "internal"
}

export const presentError = (error: GatewayError): ErrorPresentation => {
  const status = statusOf(error)
  return {
    code: error._tag,
    status,
    message: error.message,
    hint: error.hint,
    retryable: error.retryable,
    category: categoryOf(error, status),
    traceId: error._tag === "GatewayFailure" ? error.traceId : undefined,
    field: error._tag === "InvalidInput" ? error.field : undefined,
    issues: error._tag === "InvalidInput" ? (error.issues ?? []) : []
  }
}

/** The plain-text form agents read, on MCP and in the CLI: the cause, the next step, and how to treat a retry. */
export const describeError = (error: GatewayError): string => {
  const presentation = presentError(error)
  const issues =
    presentation.issues.length < 2 ? [] : presentation.issues.map((issue) => `  ${issue.path}: ${issue.message}`)
  return [
    presentation.message,
    ...issues,
    ...(presentation.hint === undefined || issues.length > 0 ? [] : [`Next: ${presentation.hint}`]),
    `Code: ${presentation.code} (HTTP ${presentation.status}); retryable: ${presentation.retryable ? "yes" : "no"}`
  ].join("\n")
}

/** Any way a call to a gateway can fail on the client, before it is told as the error the gateway would have sent. */
export type GatewayCallFailure = GatewayError | HttpClientError.HttpClientError | Schema.SchemaError

/**
 * Every failure of a gateway call as a `GatewayError`: the gateway's own
 * errors as they are, and failures it never answered with told as one.
 */
export const asGatewayError = (failure: GatewayCallFailure): GatewayError => {
  if (isGatewayError(failure)) return failure
  if (Schema.isSchemaError(failure)) return InvalidInput.fromSchemaError("request", failure)
  const response = failure.response
  if (response === undefined) {
    return new GatewayUnavailable({ url: new URL(failure.request.url).origin, detail: failure.reason.message })
  }
  return new UnexpectedResponse({ method: failure.request.method, url: failure.request.url, status: response.status })
}
