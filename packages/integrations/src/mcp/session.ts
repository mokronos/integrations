import {
  Client,
  InsufficientScopeError,
  ProtocolError,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  SSEClientTransport,
  SseError,
  StreamableHTTPClientTransport,
  UnauthorizedError
} from "@modelcontextprotocol/client"
import type { FetchLike, VersionNegotiationMode } from "@modelcontextprotocol/client"
import { Data, Duration, Effect, Option, Predicate, Schema } from "effect"
import type { Scope } from "effect"
import { McpError } from "../errors.ts"
import type { McpFailureReason } from "../errors.ts"
import { DestinationRefused, gatewayUserAgent } from "../egress/egress.ts"
import { hostOf, refusedDestination, transportCode } from "../unreachable.ts"
import { gatewayVersion, whenPresent } from "@integragents/contracts"
import type { McpEra } from "@integragents/contracts"
import { legacyElicitationAnswer } from "./unrelayable-input.ts"
import { tracedFetch } from "@integragents/observability"

export const PROTOCOL_VERSION = "2026-07-28"

const clientInfo = { name: gatewayUserAgent, version: gatewayVersion }

export const requestMeta = {
  "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
  "io.modelcontextprotocol/clientInfo": clientInfo,
  "io.modelcontextprotocol/clientCapabilities": {}
} as const

const connectTimeout = Duration.seconds(30)
const cleanupTimeout = Duration.seconds(1)

export interface McpCredential {
  readonly headerName: string
  readonly headerValue: string
}

const credentialHeaders = (credential: Option.Option<McpCredential>): Record<string, string> =>
  Option.match(credential, {
    onNone: () => ({}),
    onSome: (present) => ({ [present.headerName]: present.headerValue })
  })

export interface McpServer {
  readonly endpoint: string
  readonly era: Option.Option<McpEra>
}

const negotiation = (era: Option.Option<McpEra>): VersionNegotiationMode =>
  Option.match(era, {
    onNone: () => "auto",
    onSome: (known) => (known === "modern" ? { pin: PROTOCOL_VERSION } : "legacy")
  })

const excerptLimit = 600

const excerpt = (text: string): string => (text.length <= excerptLimit ? text : `${text.slice(0, excerptLimit)}…`)

const ErrorBody = Schema.Union([
  Schema.Struct({ message: Schema.String }),
  Schema.Struct({ error: Schema.String }),
  Schema.Struct({ error: Schema.Struct({ message: Schema.String }) })
])
const decodeErrorBody = Schema.decodeUnknownOption(Schema.fromJsonString(ErrorBody))

/** The message a JSON error body was written to carry; any other body says nothing. */
const providerMessage = (text: string): Option.Option<string> =>
  Option.map(decodeErrorBody(text), (body) =>
    "message" in body ? body.message : Predicate.isString(body.error) ? body.error : body.error.message
  )

/** What the last request on a session learned about the server, apart from the SDK's error text. */
type Exchange =
  | {
      readonly kind: "rejected"
      readonly status: number
      readonly headers: globalThis.Headers
      readonly message: Option.Option<string>
    }
  | { readonly kind: "unreachable"; readonly code: Option.Option<string> }
  | { readonly kind: "blocked"; readonly detail: string }

interface ExchangeLog {
  last: Option.Option<Exchange>
}

class CrossOriginRequest extends Error {
  constructor(readonly origin: string) {
    super(`the session tried to reach ${origin}, outside the endpoint's origin`)
    this.name = "CrossOriginRequest"
  }
}

const recordFailure =
  (log: ExchangeLog, init: RequestInit | undefined) =>
  (cause: unknown): never => {
    if (init?.signal?.aborted !== true) {
      log.last = Option.some(
        Option.match(refusedDestination(cause), {
          onNone: (): Exchange => ({ kind: "unreachable", code: transportCode(cause) }),
          onSome: (refused): Exchange => ({ kind: "blocked", detail: refused.message })
        })
      )
    }
    throw cause
  }

/**
 * The transport's `fetch`: only the endpoint's origin, a default User-Agent,
 * and a record of how the last POST was turned down, since the SDK reports
 * that as text that may embed the response body.
 */
const sessionFetch =
  (endpoint: URL, send: FetchLike, log: ExchangeLog): FetchLike =>
  async (url, init) => {
    const target = new URL(url)
    if (target.origin !== endpoint.origin) throw new CrossOriginRequest(target.origin)
    const method = (init?.method ?? "GET").toUpperCase()
    if (method === "POST") log.last = Option.none()
    const headers = new globalThis.Headers(init?.headers)
    if (!headers.has("user-agent")) headers.set("user-agent", gatewayUserAgent)
    const response = await send(target, { ...init, headers }).catch(recordFailure(log, init))
    if (method !== "POST" || response.status < 400) return response
    const text = await response.text()
    log.last = Option.some({
      kind: "rejected",
      status: response.status,
      headers: response.headers,
      message: providerMessage(text)
    })
    return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers })
  }

class SessionFailure extends Data.TaggedError("SessionFailure")<{
  readonly reason: McpFailureReason
  readonly detail: string
  readonly status: Option.Option<number>
  /** The server's own answer, which the caller can act on. */
  readonly refusal: Option.Option<string>
  /** For spans and logs only: an errno-style code or the SDK's error class. */
  readonly diagnostic: Option.Option<string>
}> {}

export const failure = (
  reason: McpFailureReason,
  detail: string,
  fields: {
    readonly status?: number
    readonly refusal?: string
    readonly diagnostic?: Option.Option<string>
  } = {}
) =>
  new SessionFailure({
    reason,
    detail,
    status: Option.fromNullishOr(fields.status),
    refusal: Option.fromNullishOr(fields.refusal),
    diagnostic: fields.diagnostic ?? Option.none()
  })

const rateLimited = (headers: globalThis.Headers): boolean => {
  const retry = headers.get("retry-after")
  return (
    headers.get("x-ratelimit-remaining") === "0" ||
    (retry !== null && (/^\d+$/.test(retry) || !Number.isNaN(Date.parse(retry))))
  )
}

const insufficientScope = (headers: globalThis.Headers): boolean =>
  /\bBearer\b.*\berror="insufficient_scope"/i.test(headers.get("www-authenticate") ?? "")

export const httpFailure = (
  status: number,
  headers: globalThis.Headers,
  message: Option.Option<string>
): SessionFailure => {
  if (status === 401) return failure("unauthorized", "the server rejected the credential (HTTP 401)", { status })
  if (status === 429 || (status === 403 && rateLimited(headers))) {
    return failure("rate_limited", `the server is rate limiting requests (HTTP ${status})`, { status })
  }
  if (status === 403) {
    return insufficientScope(headers)
      ? failure("forbidden", "the credential lacks a permission this needs (HTTP 403)", { status })
      : failure("rejected", "the server denied access (HTTP 403)", { status })
  }
  if (status >= 500) return failure("unavailable", `the server failed (HTTP ${status})`, { status })
  return Option.match(message, {
    onNone: () => failure("rejected", `the server rejected the request (HTTP ${status})`, { status }),
    onSome: (said) =>
      failure("refused", `the server refused it (HTTP ${status}): ${excerpt(said)}`, {
        status,
        refusal: excerpt(said)
      })
  })
}

const sdkName = (cause: unknown): string =>
  cause instanceof SdkError ? `${cause.name} ${cause.code}` : cause instanceof Error ? cause.name : "a non-error value"

const isAbort = (cause: unknown): boolean =>
  cause instanceof Error && (cause.name === "AbortError" || cause.name === "TimeoutError")

/**
 * Turns whatever the SDK threw into a reason. Only structure is read: status
 * codes, headers, error classes and a JSON-RPC error's own message. The SDK's
 * other messages can embed response bodies, so none of them is copied.
 */
const classify =
  (host: string, log: ExchangeLog) =>
  (cause: unknown): SessionFailure => {
    if (cause instanceof ProtocolError) {
      const said = cause.message.trim()
      return failure(
        "refused",
        `the server refused it (JSON-RPC ${cause.code})${said.length === 0 ? "" : `: ${excerpt(said)}`}`,
        { refusal: said.length === 0 ? `The server refused the call (JSON-RPC ${cause.code})` : excerpt(said) }
      )
    }
    const recorded = Option.getOrUndefined(log.last)
    if (recorded !== undefined) {
      switch (recorded.kind) {
        case "rejected":
          return httpFailure(recorded.status, recorded.headers, recorded.message)
        case "unreachable":
          return failure("network", `could not reach ${host}`, { diagnostic: recorded.code })
        case "blocked":
          return failure("network", recorded.detail)
      }
    }
    const none = new globalThis.Headers()
    if (cause instanceof UnauthorizedError) return httpFailure(401, none, Option.none())
    if (cause instanceof InsufficientScopeError) {
      return failure("forbidden", "the credential lacks a permission this needs (HTTP 403)", { status: 403 })
    }
    if (cause instanceof SdkHttpError) return httpFailure(cause.status, none, Option.none())
    if (cause instanceof SseError && cause.code !== undefined) return httpFailure(cause.code, none, Option.none())
    if ((cause instanceof SdkError && cause.code === SdkErrorCode.RequestTimeout) || isAbort(cause)) {
      return failure("timeout", "the server did not answer in time")
    }
    if (cause instanceof DestinationRefused) return failure("network", cause.message)
    if (cause instanceof CrossOriginRequest) return failure("protocol", cause.message)
    return failure("protocol", `the server's answer was not usable MCP (${sdkName(cause)})`, {
      diagnostic: Option.some(sdkName(cause))
    })
  }

export const asMcpError = (endpoint: string, phase: Option.Option<string>) => (failed: SessionFailure) =>
  Effect.gen(function* () {
    if (Option.isSome(failed.diagnostic)) {
      yield* Effect.annotateCurrentSpan({ "mcp.failure.reason": failed.reason, "error.type": failed.diagnostic.value })
      if (failed.reason === "network") {
        yield* Effect.logWarning("MCP endpoint unreachable").pipe(
          Effect.annotateLogs({
            "server.address": hostOf(endpoint),
            "error.code": failed.diagnostic.value
          })
        )
      }
    }
    return yield* new McpError({
      endpoint,
      reason: failed.reason,
      detail: Option.match(phase, { onNone: () => failed.detail, onSome: (name) => `${name}: ${failed.detail}` }),
      ...whenPresent("status", Option.getOrUndefined(failed.status))
    })
  })

/** A handshake that failed, the only failure that may be retried over the other transport. */
class ConnectFailure extends Data.TaggedError("ConnectFailure")<{ readonly failure: SessionFailure }> {}

interface Session {
  readonly client: Client
  readonly run: <A>(request: (client: Client) => Promise<A>) => Effect.Effect<A, SessionFailure>
  /** What a 2025-era server asked by pushing `elicitation/create`, each declined. */
  readonly declined: ReadonlyArray<string>
}

type TransportKind = "streamable-http" | "sse"

const release = (client: Client, transport: StreamableHTTPClientTransport | SSEClientTransport) =>
  Effect.gen(function* () {
    if (transport instanceof StreamableHTTPClientTransport && transport.sessionId !== undefined) {
      yield* Effect.tryPromise(() => transport.terminateSession()).pipe(Effect.timeout(cleanupTimeout), Effect.ignore)
    }
    yield* Effect.tryPromise(() => client.close()).pipe(Effect.timeout(cleanupTimeout), Effect.ignore)
  })

const openSession = (
  send: FetchLike,
  server: McpServer,
  credential: Option.Option<McpCredential>,
  kind: TransportKind
): Effect.Effect<Session, ConnectFailure, Scope.Scope> =>
  Effect.gen(function* () {
    const endpoint = URL.parse(server.endpoint)
    if (endpoint === null) {
      return yield* new ConnectFailure({ failure: failure("protocol", "the endpoint is not a URL") })
    }
    const context = yield* Effect.context<never>()
    const log: ExchangeLog = { last: Option.none() }
    const fetch = sessionFetch(endpoint, tracedFetch(context, send), log)
    const requestInit = { headers: credentialHeaders(credential) }
    const declined: Array<string> = []
    const { client, transport } = yield* Effect.acquireRelease(
      Effect.sync(() => ({
        client: new Client(clientInfo, {
          capabilities: { elicitation: { form: {} } },
          inputRequired: { autoFulfill: false },
          versionNegotiation: { mode: kind === "sse" ? "legacy" : negotiation(server.era) }
        }),
        transport:
          kind === "sse"
            ? new SSEClientTransport(endpoint, { requestInit, fetch })
            : new StreamableHTTPClientTransport(endpoint, { requestInit, fetch })
      })),
      ({ client, transport }) => release(client, transport)
    )
    client.setRequestHandler("elicitation/create", async (request) => {
      declined.push(request.params.message)
      return legacyElicitationAnswer
    })
    const run = <A>(request: (client: Client) => Promise<A>) =>
      Effect.tryPromise({ try: () => request(client), catch: classify(endpoint.host, log) })
    yield* run((session) => session.connect(transport)).pipe(
      Effect.timeoutOrElse({
        duration: connectTimeout,
        orElse: () => Effect.fail(failure("timeout", "the server did not finish connecting in time"))
      }),
      Effect.mapError((failed) => new ConnectFailure({ failure: failed })),
      Effect.withSpan("McpClient.connect", { attributes: { "mcp.transport": kind } })
    )
    return { client, run, declined }
  })

const fallsBackToSse = (failed: ConnectFailure): boolean =>
  Option.exists(failed.failure.status, (status) => status === 404 || status === 405)

/**
 * One session for one operation. A server that answers the Streamable HTTP
 * handshake with 404 or 405 only speaks the older HTTP+SSE transport. Only the
 * handshake falls back; whatever `use` sends is never sent twice.
 */
export const withClient = <A, E>(
  send: FetchLike,
  server: McpServer,
  credential: Option.Option<McpCredential>,
  use: (session: Session) => Effect.Effect<A, E>
): Effect.Effect<A, E | McpError> => {
  const session = openSession(send, server, credential, "streamable-http").pipe(
    Effect.catchTag("ConnectFailure", (failed) =>
      fallsBackToSse(failed) ? openSession(send, server, credential, "sse") : Effect.fail(failed)
    ),
    Effect.catchTag("ConnectFailure", (failed) => asMcpError(server.endpoint, Option.none())(failed.failure))
  )
  return Effect.scoped(Effect.flatMap(session, use))
}
