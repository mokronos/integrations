import { ApprovalStatus, whenPresent } from "@mokronos/contracts"
import { Effect, Predicate, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import type { HttpMethod } from "effect/unstable/http"
import {
  Connection,
  Integration,
  Tool,
  ToolSummary,
  IntegrationOverview
} from "@mokronos/contracts"
import {
  IntegrationDiscovery,
  IntegrationValidationReport
} from "@mokronos/contracts"
import { IntegrationSearchResponse } from "@mokronos/contracts"
import {
  GatewayMetadata,
  gatewayProtocolVersion
} from "@mokronos/contracts"

export interface GatewayClientOptions {
  readonly url: string
  readonly apiKey: string
}

export class GatewayError extends Error {
  readonly status: number
  readonly body: Json

  constructor(status: number, body: Json, message: string) {
    super(message)
    this.name = "GatewayError"
    this.status = status
    this.body = body
  }
}

export class GatewayTransportError extends Error {
  readonly method: string
  readonly path: string

  constructor(method: string, path: string, detail: string) {
    super(`${method} ${path} could not reach the gateway: ${detail}`)
    this.name = "GatewayTransportError"
    this.method = method
    this.path = path
  }
}

export class GatewayDecodeError extends Error {
  readonly path: string

  constructor(path: string, detail: string) {
    super(`The gateway's answer to ${path} was unreadable: ${detail}`)
    this.name = "GatewayDecodeError"
    this.path = path
  }
}

export class GatewayProtocolError extends Error {
  readonly expected: number
  readonly received: number | undefined

  constructor(received: number | undefined, detail?: string) {
    const actual = received === undefined ? "missing" : String(received)
    super(
      `Incompatible gateway protocol: client requires ${gatewayProtocolVersion}, gateway reported ${actual}` +
        (detail === undefined ? "" : ` (${detail})`)
    )
    this.name = "GatewayProtocolError"
    this.expected = gatewayProtocolVersion
    this.received = received
  }
}

export type GatewayFailure =
  | GatewayError
  | GatewayTransportError
  | GatewayDecodeError
  | GatewayProtocolError

export type GatewayEffect<A> = Effect.Effect<A, GatewayFailure>

type Json = typeof Schema.Json.Type

const decodeGatewayMetadata = Schema.decodeUnknownEffect(GatewayMetadata)

export const readGatewayMetadata = Effect.fn("GatewayClient.readMetadata")(function*(
  url: string
): Effect.fn.Return<GatewayMetadata, GatewayProtocolError, HttpClient.HttpClient> {
  const response = yield* HttpClient.get(`${url.replace(/\/+$/, "")}/v1/metadata`).pipe(
    Effect.mapError((cause) =>
      new GatewayProtocolError(undefined, `metadata could not be read: ${cause.message}`)
    )
  )
  if (response.status < 200 || response.status >= 300) {
    return yield* Effect.fail(
      new GatewayProtocolError(undefined, `metadata returned HTTP ${response.status}`)
    )
  }
  const metadata = yield* response.json.pipe(
    Effect.flatMap(decodeGatewayMetadata),
    Effect.mapError(() => new GatewayProtocolError(undefined, "gateway metadata is malformed"))
  )
  if (metadata.protocolVersion !== gatewayProtocolVersion) {
    return yield* Effect.fail(
      new GatewayProtocolError(metadata.protocolVersion, `gateway ${metadata.gatewayVersion}`)
    )
  }
  return metadata
})

export const InvocationOutcome = Schema.Union([
  Schema.Struct({ status: Schema.Literal("succeeded"), result: Schema.Json }),
  Schema.Struct({
    status: Schema.Literal("pending"),
    approvalId: Schema.String,
    expiresAt: Schema.String,
    approvalUrl: Schema.optional(Schema.String)
  }),
  Schema.Struct({ status: Schema.Literal("denied"), reason: Schema.String }),
  Schema.Struct({ status: Schema.Literal("failed"), message: Schema.String })
])
export type InvocationOutcome = typeof InvocationOutcome.Type

export const ApprovalRecord = Schema.Struct({
  id: Schema.String,
  alias: Schema.String,
  tool: Schema.String,
  status: ApprovalStatus,
  arguments: Schema.Json,
  createdAt: Schema.String,
  expiresAt: Schema.String,
  decidedBy: Schema.NullOr(Schema.String),
  result: Schema.NullOr(Schema.Json),
  error: Schema.NullOr(Schema.String),
  collectedAt: Schema.NullOr(Schema.String)
})
export type ApprovalRecord = typeof ApprovalRecord.Type

export const GatewayIntegrationsResponse = Schema.Struct({
  integrations: Schema.Array(IntegrationOverview),
  oauthCallbackUrl: Schema.optional(Schema.NullOr(Schema.String))
})
export type GatewayIntegrationsResponse = typeof GatewayIntegrationsResponse.Type

export const IntegrationToolsResponse = Schema.Struct({
  tools: Schema.Array(ToolSummary)
})
export type IntegrationToolsResponse = typeof IntegrationToolsResponse.Type

export const ConnectionCreated = Schema.Struct({
  connection: Connection,
  tools: Schema.Array(ToolSummary)
})
export type ConnectionCreated = typeof ConnectionCreated.Type

export const OAuthSession = Schema.Struct({
  id: Schema.String,
  integration: Schema.String,
  connection: Schema.String,
  state: Schema.Union([
    Schema.Struct({
      status: Schema.Literal("pending"),
      authorizationUrl: Schema.String
    }),
    Schema.Struct({
      status: Schema.Literal("connected"),
      connection: Connection
    }),
    Schema.Struct({
      status: Schema.Literal("failed"),
      message: Schema.String
    })
  ])
})
export type OAuthSession = typeof OAuthSession.Type

export const ConnectionsResponse = Schema.Struct({
  connections: Schema.Array(Connection)
})
export type ConnectionsResponse = typeof ConnectionsResponse.Type

export const DisconnectedConnection = Schema.Struct({
  removed: Schema.Boolean,
  integration: Schema.String,
  connection: Schema.String
})
export type DisconnectedConnection = typeof DisconnectedConnection.Type

export const RegistrySearchInput = Schema.Struct({
  query: Schema.String,
  kind: Schema.optional(Schema.Literals(["mcp", "openapi", "graphql", "cli"])),
  limit: Schema.optional(Schema.Number)
})
export type RegistrySearchInput = typeof RegistrySearchInput.Type

export const DiscoverIntegrationInput = Schema.Struct({
  url: Schema.String,
  connection: Schema.optional(Schema.String),
  slug: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String)
})
export type DiscoverIntegrationInput = typeof DiscoverIntegrationInput.Type

export const EffectiveTool = Schema.Struct({
  alias: Schema.String,
  tool: Schema.String,
  connection: Schema.Struct({
    owner: Schema.String,
    integration: Schema.String,
    name: Schema.String
  })
})
export type EffectiveTool = typeof EffectiveTool.Type

export const EffectiveToolsResponse = Schema.Struct({
  tools: Schema.Array(EffectiveTool)
})
export type EffectiveToolsResponse = typeof EffectiveToolsResponse.Type

export const IntegrationToolInput = Schema.Struct({
  integration: Schema.String,
  tool: Schema.String,
  connection: Schema.optional(Schema.String)
})
export type IntegrationToolInput = typeof IntegrationToolInput.Type

export const CreateConnectionInput = Schema.Struct({
  integration: Schema.String,
  connection: Schema.optional(Schema.String),
  template: Schema.optional(Schema.String),
  values: Schema.optional(Schema.Record(Schema.String, Schema.String))
})
export type CreateConnectionInput = typeof CreateConnectionInput.Type

export const StartOAuthInput = Schema.Struct({
  integration: Schema.String,
  connection: Schema.optional(Schema.String),
  template: Schema.optional(Schema.String),
  clientId: Schema.optional(Schema.String),
  clientSecret: Schema.optional(Schema.String),
  timeoutSeconds: Schema.optional(Schema.Number)
})
export type StartOAuthInput = typeof StartOAuthInput.Type

export const DisconnectInput = Schema.Struct({
  integration: Schema.String,
  connection: Schema.String
})
export type DisconnectInput = typeof DisconnectInput.Type

export const ValidateInput = Schema.Struct({
  node: Schema.Json,
  live: Schema.optional(Schema.Boolean)
})
export type ValidateInput = typeof ValidateInput.Type

const decodeOutcome = Schema.decodeUnknownEffect(InvocationOutcome)
const decodeApproval = Schema.decodeUnknownEffect(ApprovalRecord)
const decodeSearch = Schema.decodeUnknownEffect(IntegrationSearchResponse)
const decodeDiscovery = Schema.decodeUnknownEffect(IntegrationDiscovery)
const decodeIntegrations = Schema.decodeUnknownEffect(GatewayIntegrationsResponse)
const decodeIntegrationTools = Schema.decodeUnknownEffect(IntegrationToolsResponse)
const decodeIntegrationTool = Schema.decodeUnknownEffect(Tool)
const decodeConnectionCreated = Schema.decodeUnknownEffect(ConnectionCreated)
const decodeOAuthSession = Schema.decodeUnknownEffect(OAuthSession)
const decodeConnections = Schema.decodeUnknownEffect(ConnectionsResponse)
const decodeDisconnectedConnection = Schema.decodeUnknownEffect(DisconnectedConnection)
const decodeValidation = Schema.decodeUnknownEffect(IntegrationValidationReport)
const decodeIntegration = Schema.decodeUnknownEffect(Integration)
const decodeEffectiveTools = Schema.decodeUnknownEffect(EffectiveToolsResponse)
const isOutcome = Schema.is(InvocationOutcome)

export interface GatewayClient {
  readonly url: string

  metadata(): GatewayEffect<GatewayMetadata>

  search(input: RegistrySearchInput): GatewayEffect<IntegrationSearchResponse>
  discover(input: DiscoverIntegrationInput): GatewayEffect<IntegrationDiscovery>
  renameIntegration(
    input: { readonly integration: string; readonly name: string }
  ): GatewayEffect<Integration>
  integrations(): GatewayEffect<GatewayIntegrationsResponse>
  integrationTools(integration: string): GatewayEffect<IntegrationToolsResponse>
  integrationTool(input: IntegrationToolInput): GatewayEffect<Tool>
  effectiveTools(): GatewayEffect<EffectiveToolsResponse>
  connect(input: CreateConnectionInput): GatewayEffect<ConnectionCreated>
  startOAuth(input: StartOAuthInput): GatewayEffect<OAuthSession>
  oauth(id: string): GatewayEffect<OAuthSession>
  connections(): GatewayEffect<ConnectionsResponse>
  disconnect(input: DisconnectInput): GatewayEffect<DisconnectedConnection>
  validate(input: ValidateInput): GatewayEffect<IntegrationValidationReport>

  execute(input: {
    readonly alias: string
    readonly tool: string
    readonly arguments?: Json
  }): GatewayEffect<InvocationOutcome>
  approval(id: string): GatewayEffect<ApprovalRecord>
  health(): Effect.Effect<boolean>
}

interface RawResponse {
  readonly ok: boolean
  readonly status: number
  readonly parsed: Json
}

const failure = (method: string, path: string, status: number, parsed: Json): GatewayError => {
  const message = Predicate.isObjectOrArray(parsed)
    ? "error" in parsed
      ? String(parsed["error"])
      : "reason" in parsed
      ? String(parsed["reason"])
      : `${method} ${path} failed with ${status}`
    : `${method} ${path} failed with ${status}`
  return new GatewayError(status, parsed, message)
}

export const makeGatewayClient = Effect.fn("GatewayClient.make")(function*(
  options: GatewayClientOptions
): Effect.fn.Return<GatewayClient, never, HttpClient.HttpClient> {
  const http = yield* HttpClient.HttpClient
  const base = options.url.replace(/\/+$/, "")
  const metadata = yield* Effect.cached(
    readGatewayMetadata(base).pipe(Effect.provideService(HttpClient.HttpClient, http))
  )

  const send = Effect.fn("GatewayClient.send")(function*(
    method: HttpMethod.HttpMethod,
    path: string,
    body?: Json
  ): Effect.fn.Return<RawResponse, GatewayFailure> {
    yield* metadata
    const request = HttpClientRequest.make(method)(`${base}${path}`, {
      headers: { authorization: `Bearer ${options.apiKey}` }
    })
    const response = yield* http.execute(
      body === undefined ? request : HttpClientRequest.bodyJsonUnsafe(request, body)
    ).pipe(
      Effect.mapError((cause) => new GatewayTransportError(method, path, cause.message))
    )
    const parsed = yield* response.json.pipe(
      Effect.mapError((cause) => new GatewayDecodeError(path, cause.message))
    )
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      parsed
    }
  })

  const request = Effect.fn("GatewayClient.request")(function*(
    method: HttpMethod.HttpMethod,
    path: string,
    body?: Json
  ): Effect.fn.Return<Json, GatewayFailure> {
    const response = yield* send(method, path, body)
    if (!response.ok) {
      return yield* Effect.fail(failure(method, path, response.status, response.parsed))
    }
    return response.parsed
  })

  const decoded = <A>(
    path: string,
    payload: Effect.Effect<Json, GatewayFailure>,
    decode: (value: Json) => Effect.Effect<A, Schema.SchemaError>
  ): GatewayEffect<A> =>
    Effect.flatMap(payload, (value) =>
      decode(value).pipe(
        Effect.mapError((cause) => new GatewayDecodeError(path, cause.message))
      ))

  return {
    url: base,
    metadata: () => metadata,
    search: (input) => {
      const parameters = new URLSearchParams({
        q: input.query,
        limit: String(input.limit ?? 5)
      })
      if (input.kind !== undefined) parameters.set("kind", input.kind)
      const path = `/v1/registry/search?${parameters.toString()}`
      return decoded(path, request("GET", path), decodeSearch)
    },
    discover: (input) =>
      decoded("/v1/integrations/discover", request("POST", "/v1/integrations/discover", {
        url: input.url,
        ...whenPresent("connection", input.connection),
        ...whenPresent("slug", input.slug),
        ...whenPresent("name", input.name)
      }), decodeDiscovery),
    renameIntegration: (input) => {
      const path = `/v1/integrations/${encodeURIComponent(input.integration)}/name`
      return decoded(path, request("POST", path, { name: input.name }), decodeIntegration)
    },
    integrations: () =>
      decoded("/v1/integrations", request("GET", "/v1/integrations"), decodeIntegrations),
    effectiveTools: () =>
      decoded("/v1/tools", request("GET", "/v1/tools"), decodeEffectiveTools),
    integrationTools: (integration) => {
      const path = `/v1/integrations/${encodeURIComponent(integration)}/tools`
      return decoded(path, request("GET", path), decodeIntegrationTools)
    },
    integrationTool: (input) => {
      const parameters = input.connection === undefined
        ? ""
        : `?connection=${encodeURIComponent(input.connection)}`
      const path =
        `/v1/integrations/${encodeURIComponent(input.integration)}/tools/${encodeURIComponent(input.tool)}${parameters}`
      return decoded(path, request("GET", path), decodeIntegrationTool)
    },
    connect: (input) =>
      decoded("/v1/connections", request("POST", "/v1/connections", {
        integration: input.integration,
        ...whenPresent("connection", input.connection),
        ...whenPresent("template", input.template),
        ...whenPresent("values", input.values)
      }), decodeConnectionCreated),
    startOAuth: (input) =>
      decoded("/v1/connections/oauth", request("POST", "/v1/connections/oauth", {
        integration: input.integration,
        ...whenPresent("connection", input.connection),
        ...whenPresent("template", input.template),
        ...whenPresent("clientId", input.clientId),
        ...whenPresent("clientSecret", input.clientSecret),
        ...whenPresent("timeoutSeconds", input.timeoutSeconds)
      }), decodeOAuthSession),
    oauth: (id) => {
      const path = `/v1/connections/oauth/${encodeURIComponent(id)}`
      return decoded(path, request("GET", path), decodeOAuthSession)
    },
    connections: () =>
      decoded("/v1/connections", request("GET", "/v1/connections"), decodeConnections),
    disconnect: (input) => {
      const path =
        `/v1/connections/${encodeURIComponent(input.integration)}/${encodeURIComponent(input.connection)}`
      return decoded(path, request("DELETE", path), decodeDisconnectedConnection)
    },
    validate: (input) =>
      decoded("/v1/validate", request("POST", "/v1/validate", {
        node: input.node,
        ...whenPresent("live", input.live)
      }), decodeValidation),
    execute: (input) =>
      decoded(
        "/v1/execute",
        send("POST", "/v1/execute", {
          alias: input.alias,
          tool: input.tool,
          arguments: input.arguments ?? {}
        }).pipe(Effect.flatMap((response) =>
          !response.ok && !isOutcome(response.parsed)
            ? Effect.fail(failure("POST", "/v1/execute", response.status, response.parsed))
            : Effect.succeed(response.parsed)
        )),
        decodeOutcome
      ),
    approval: (id) => {
      const path = `/v1/approvals/${id}`
      return decoded(path, request("GET", path), decodeApproval)
    },
    health: () => Effect.match(metadata, { onFailure: () => false, onSuccess: () => true })
  }
})


export {
  Connection,
  Tool,
  ToolSummary,
  GatewayMetadata,
  gatewayProtocolVersion,
  IntegrationDiscovery,
  IntegrationOverview,
  IntegrationSearchResponse,
  IntegrationValidationReport
}
