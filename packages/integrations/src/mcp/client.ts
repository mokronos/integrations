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
import { Context, Data, Duration, Effect, Layer, Option, Predicate, Schema } from "effect"
import type { Scope } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { McpError } from "../errors.ts"
import type { McpFailureReason } from "../errors.ts"
import { DestinationRefused, Egress, gatewayUserAgent } from "../egress/egress.ts"
import { OAuthProtocol } from "../oauth/protocol.ts"
import type { Protocol } from "../oauth/protocol.ts"
import { hostOf, refusedDestination, transportCode } from "../unreachable.ts"
import { serviceName, slugify } from "@integragents/contracts"
import { whenPresent } from "@integragents/contracts"
import { isJsonObject, parseJsonString, type Json, type JsonObject } from "@integragents/contracts"
import { InputRequests, McpEra, McpProbe } from "@integragents/contracts"
import type { InputAnswer, InputRound } from "@integragents/contracts"
import { legacyElicitationAnswer } from "./unrelayable-input.ts"
import { tracedFetch } from "@integragents/observability"

const PROTOCOL_VERSION = "2026-07-28"

const clientInfo = { name: "@integragents/integrations", version: "0.2.0" } as const

const requestMeta = {
  "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
  "io.modelcontextprotocol/clientInfo": clientInfo,
  "io.modelcontextprotocol/clientCapabilities": {}
} as const

const connectTimeout = Duration.seconds(30)
const cleanupTimeout = Duration.seconds(1)

const McpToolAnnotations = Schema.Struct({
  title: Schema.optional(Schema.String),
  readOnlyHint: Schema.optional(Schema.Boolean),
  destructiveHint: Schema.optional(Schema.Boolean),
  idempotentHint: Schema.optional(Schema.Boolean),
  openWorldHint: Schema.optional(Schema.Boolean)
})
export type McpToolAnnotations = typeof McpToolAnnotations.Type

export const McpToolDefinition = Schema.Struct({
  name: Schema.String,
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  inputSchema: Schema.optional(Schema.Json),
  outputSchema: Schema.optional(Schema.Json),
  annotations: Schema.optional(McpToolAnnotations)
})
export type McpToolDefinition = typeof McpToolDefinition.Type

const decodeTools = Schema.decodeUnknownEffect(Schema.Array(McpToolDefinition))
const decodeJson = Schema.decodeUnknownEffect(Schema.Json)

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

export interface McpToolListing {
  readonly tools: ReadonlyArray<McpToolDefinition>
  readonly era: McpEra
}

const negotiation = (era: Option.Option<McpEra>): VersionNegotiationMode =>
  Option.match(era, {
    onNone: () => "auto",
    onSome: (known) => (known === "modern" ? { pin: PROTOCOL_VERSION } : "legacy")
  })

const callArguments = (input: Json): JsonObject | undefined => (isJsonObject(input) ? input : undefined)

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

const failure = (
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

const httpFailure = (status: number, headers: globalThis.Headers, message: Option.Option<string>): SessionFailure => {
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

const asMcpError = (endpoint: string, phase: Option.Option<string>) => (failed: SessionFailure) =>
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
const withClient = <A, E>(
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

/** A tool call's outcome: its result, or a round of input it needs first (MCP 2026-07-28 `input_required`). */
export type McpCallResult =
  | { readonly kind: "complete"; readonly result: Json; readonly declined: ReadonlyArray<string> }
  | { readonly kind: "input-required"; readonly round: InputRound }

const InputRequiredResult = Schema.Struct({
  resultType: Schema.Literal("input_required"),
  inputRequests: Schema.optional(InputRequests),
  requestState: Schema.optional(Schema.String)
})
const decodeInputRequiredResult = Schema.decodeUnknownOption(InputRequiredResult)

const callResultOf = (result: Json, declined: ReadonlyArray<string>): McpCallResult =>
  Option.match(decodeInputRequiredResult(result), {
    onNone: (): McpCallResult => ({ kind: "complete", result, declined: [...declined] }),
    onSome: (asked): McpCallResult => ({
      kind: "input-required",
      round: { inputRequests: asked.inputRequests ?? {}, ...whenPresent("requestState", asked.requestState) }
    })
  })

/** A refusal handed back the way a tool reports its own error, so the caller can fix its arguments. */
const refusalResult = (message: string): Json => ({
  content: [{ type: "text", text: message }],
  isError: true
})

interface McpAuthority {
  readonly supportsDynamicRegistration: boolean
  readonly scopes: ReadonlyArray<string>
}

/** The authorization server the endpoint names, the way a connection will discover it. */
const inspectAuthority = (protocol: Protocol, endpoint: string): Effect.Effect<Option.Option<McpAuthority>> =>
  protocol.discoverServer(endpoint).pipe(
    Effect.map((found) =>
      Option.some({
        supportsDynamicRegistration: found.server.registration_endpoint !== undefined,
        scopes:
          Option.getOrUndefined(found.challenge)?.scopes ??
          Option.getOrUndefined(found.resource)?.scopes_supported ??
          []
      })
    ),
    Effect.orElseSucceed(() => Option.none<McpAuthority>())
  )

const ServerInfo = Schema.Struct({
  name: Schema.String,
  title: Schema.optional(Schema.String),
  version: Schema.optional(Schema.String)
})

const DiscoverResult = Schema.Struct({
  supportedVersions: Schema.Array(Schema.String),
  instructions: Schema.optional(Schema.String),
  _meta: Schema.optional(
    Schema.Struct({
      "io.modelcontextprotocol/serverInfo": Schema.optional(ServerInfo)
    })
  )
})

const JsonRpcError = Schema.Struct({
  code: Schema.Number,
  message: Schema.optional(Schema.String)
})

const DiscoverResponse = Schema.Struct({
  result: Schema.optional(DiscoverResult),
  error: Schema.optional(JsonRpcError)
})

const decodeDiscoverResponse = Schema.decodeUnknownEffect(DiscoverResponse)

const lastEventData = (body: string): Option.Option<string> =>
  Option.fromNullishOr(
    body
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .pop()
  )

const unreachable = (endpoint: string, cause: unknown) =>
  asMcpError(
    endpoint,
    Option.none()
  )(
    Option.match(refusedDestination(cause), {
      onNone: () => failure("network", `could not reach ${hostOf(endpoint)}`, { diagnostic: transportCode(cause) }),
      onSome: (refused) => failure("network", refused.message)
    })
  )

const readBody = (endpoint: string, response: HttpClientResponse.HttpClientResponse): Effect.Effect<Json, McpError> =>
  response.text.pipe(
    Effect.catch((cause) => unreachable(endpoint, cause)),
    Effect.flatMap((text) => {
      const payload =
        response.headers["content-type"]?.includes("text/event-stream") === true
          ? lastEventData(text)
          : Option.some(text)
      return Option.match(Option.flatMap(payload, parseJsonString), {
        onNone: () =>
          Effect.fail(
            new McpError({
              endpoint,
              reason: "protocol",
              detail: "it answered server/discover with something other than JSON",
              status: response.status
            })
          ),
        onSome: Effect.succeed
      })
    })
  )

type Discovery =
  | { readonly kind: "auth"; readonly response: HttpClientResponse.HttpClientResponse }
  | { readonly kind: "no-streamable-http" }
  | { readonly kind: "answered"; readonly body: Json }

const probeDiscovery = (client: HttpClient.HttpClient, endpoint: string): Effect.Effect<Discovery, McpError> =>
  client
    .post(endpoint, {
      headers: {
        accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": PROTOCOL_VERSION,
        "Mcp-Method": "server/discover"
      },
      body: HttpBody.jsonUnsafe({
        jsonrpc: "2.0",
        id: 1,
        method: "server/discover",
        params: { _meta: requestMeta }
      })
    })
    .pipe(
      Effect.catch((cause) => unreachable(endpoint, cause)),
      Effect.flatMap((response): Effect.Effect<Discovery, McpError> => {
        if (response.status === 401 || response.status === 403) return Effect.succeed({ kind: "auth", response })
        if (response.status === 404 || response.status === 405) return Effect.succeed({ kind: "no-streamable-http" })
        if (response.status === 429 || response.status >= 500) {
          const failed = httpFailure(response.status, new globalThis.Headers(response.headers), Option.none())
          return asMcpError(endpoint, Option.some("server/discover"))(failed)
        }
        return Effect.map(readBody(endpoint, response), (body) => ({ kind: "answered", body }))
      })
    )

const fallbackName = (endpoint: string): string => {
  const parsed = Option.getOrUndefined(Option.liftThrowable(() => new URL(endpoint))())
  return parsed === undefined ? endpoint : serviceName(parsed.hostname)
}

const describeProbe = (endpoint: string, probe: McpProbe) =>
  Schema.decodeUnknownEffect(McpProbe)(probe).pipe(
    Effect.mapError(
      (cause) => new McpError({ endpoint, reason: "protocol", detail: "Could not describe probe", cause })
    )
  )

const authorityFields = (authority: Option.Option<McpAuthority>) => ({
  requiresOAuth: Option.isSome(authority),
  supportsDynamicRegistration: Option.match(authority, {
    onNone: () => false,
    onSome: (found) => found.supportsDynamicRegistration
  }),
  scopes: Option.match(authority, {
    onNone: (): ReadonlyArray<string> => [],
    onSome: (found) => found.scopes
  })
})

const decodeEra = (endpoint: string, client: Client) =>
  Schema.decodeUnknownEffect(McpEra)(client.getProtocolEra()).pipe(
    Effect.mapError(
      (cause) => new McpError({ endpoint, reason: "protocol", detail: "the session negotiated no protocol era", cause })
    )
  )

export class McpClient extends Context.Service<
  McpClient,
  {
    readonly probe: (endpoint: string) => Effect.Effect<McpProbe, McpError>
    readonly listTools: (
      server: McpServer,
      credential: Option.Option<McpCredential>
    ) => Effect.Effect<McpToolListing, McpError>
    /** One round of a call; `answer` continues the round a previous call ended with. */
    readonly callTool: (
      server: McpServer,
      credential: Option.Option<McpCredential>,
      tool: string,
      input: Json,
      answer?: InputAnswer
    ) => Effect.Effect<McpCallResult, McpError>
  }
>()("@integragents/integrations/McpClient") {
  static readonly layer: Layer.Layer<McpClient, never, Egress | HttpClient.HttpClient> = Layer.effect(
    McpClient,
    Effect.gen(function* () {
      const egress = yield* Egress
      const protocol = yield* OAuthProtocol
      const client = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest(HttpClientRequest.setHeader("user-agent", gatewayUserAgent))
      )

      const listTools = Effect.fn("McpClient.listTools")(
        (server: McpServer, credential: Option.Option<McpCredential>) =>
          withClient(egress.fetch, server, credential, (session) =>
            Effect.gen(function* () {
              const era = yield* decodeEra(server.endpoint, session.client)
              const listed = yield* session
                .run(async (open) => (await open.listTools()).tools)
                .pipe(Effect.catchTag("SessionFailure", asMcpError(server.endpoint, Option.some("tools/list"))))
              const tools = yield* decodeTools(listed).pipe(
                Effect.mapError(
                  (cause) =>
                    new McpError({
                      endpoint: server.endpoint,
                      reason: "protocol",
                      detail: "tools/list returned an unreadable tool",
                      cause
                    })
                )
              )
              return { tools, era }
            })
          )
      )

      /**
       * Older servers do not answer `server/discover`, so a legacy session is
       * the only way they describe themselves.
       */
      const describeLegacySession = (endpoint: string) =>
        withClient(egress.fetch, { endpoint, era: Option.some("legacy") }, Option.none(), (session) =>
          Effect.sync(() => ({
            serverName: session.client.getServerVersion()?.name ?? null,
            instructions: session.client.getInstructions() ?? null
          }))
        )

      const probe = Effect.fn("McpClient.probe")(function* (endpoint: string) {
        const [discovery, ambientAuthority] = yield* Effect.all(
          [probeDiscovery(client, endpoint), inspectAuthority(protocol, endpoint)],
          { concurrency: "unbounded" }
        )
        const name = fallbackName(endpoint)
        const slug = Option.getOrElse(slugify(name), () => "mcp")

        if (discovery.kind === "auth") {
          return yield* describeProbe(endpoint, {
            connected: false,
            requiresAuthentication: true,
            ...authorityFields(ambientAuthority),
            name,
            slug,
            era: null,
            serverName: null,
            instructions: null
          })
        }

        const answered =
          discovery.kind === "answered"
            ? yield* decodeDiscoverResponse(discovery.body).pipe(
                Effect.mapError(
                  (cause) =>
                    new McpError({
                      endpoint,
                      reason: "protocol",
                      detail: "it did not answer server/discover with a JSON-RPC response",
                      cause
                    })
                )
              )
            : { result: undefined }

        const modern = answered.result !== undefined && answered.result.supportedVersions.includes(PROTOCOL_VERSION)
        const described = modern
          ? {
              serverName: answered.result?._meta?.["io.modelcontextprotocol/serverInfo"]?.name ?? null,
              instructions: answered.result?.instructions ?? null
            }
          : yield* describeLegacySession(endpoint)

        return yield* describeProbe(endpoint, {
          connected: true,
          requiresAuthentication: Option.isSome(ambientAuthority),
          ...authorityFields(ambientAuthority),
          name: described.serverName ?? name,
          slug: described.serverName === null ? slug : Option.getOrElse(slugify(described.serverName), () => slug),
          era: modern ? "modern" : "legacy",
          serverName: described.serverName,
          instructions: described.instructions
        })
      })

      const callTool = Effect.fn("McpClient.callTool")(
        (
          server: McpServer,
          credential: Option.Option<McpCredential>,
          tool: string,
          input: Json,
          answer?: InputAnswer
        ) =>
          withClient(egress.fetch, server, credential, (session) =>
            session
              .run((open) =>
                open.callTool(
                  {
                    name: tool,
                    ...whenPresent("arguments", callArguments(input)),
                    ...whenPresent("inputResponses", answer?.inputResponses),
                    ...whenPresent("requestState", answer?.requestState)
                  },
                  { allowInputRequired: true }
                )
              )
              .pipe(
                Effect.catchTag("SessionFailure", (failed) =>
                  Option.match(failed.refusal, {
                    onSome: (message) => Effect.succeed(refusalResult(message)),
                    onNone: () => asMcpError(server.endpoint, Option.some(`tools/call ${tool}`))(failed)
                  })
                ),
                Effect.flatMap((result) =>
                  decodeJson(result).pipe(
                    Effect.mapError(
                      (cause) =>
                        new McpError({
                          endpoint: server.endpoint,
                          reason: "protocol",
                          detail: `tools/call ${tool} returned a non-JSON result`,
                          cause
                        })
                    )
                  )
                ),
                Effect.map((result) => callResultOf(result, session.declined))
              )
          )
      )

      return { probe, listTools, callTool }
    })
  ).pipe(Layer.provide(OAuthProtocol.layer))
}
