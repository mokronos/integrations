import { ApprovalStatus, whenPresent, whenPresentMap } from "@mokronos/contracts"
import { Predicate, Schema } from "effect"
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

/** The client is deliberately dumb: authenticate, send, decode. Every decision
 * about whether a call may happen, which connection serves it, and whether a
 * human is asked lives behind the gateway.
 *
 * That is the point of the split — a sandbox holding this client holds no
 * authority beyond the access profile and approval policy attached to its client. */

export interface GatewayClientOptions {
  readonly url: string
  readonly apiKey: string
  /** Injected for tests, or to route through a proxy. */
  readonly fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
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

type Json = typeof Schema.Json.Type
const decodeJsonText = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))
const decodeGatewayMetadataText = Schema.decodeUnknownSync(
  Schema.fromJsonString(GatewayMetadata)
)

export const readGatewayMetadata = async (
  url: string,
  doFetch: NonNullable<GatewayClientOptions["fetch"]> = globalThis.fetch
): Promise<GatewayMetadata> => {
  const response = await doFetch(`${url.replace(/\/+$/, "")}/v1/metadata`)
  if (!response.ok) {
    throw new GatewayProtocolError(undefined, `metadata returned HTTP ${response.status}`)
  }
  let metadata: GatewayMetadata
  try {
    metadata = decodeGatewayMetadataText(await response.text())
  } catch {
    throw new GatewayProtocolError(undefined, "gateway metadata is malformed")
  }
  if (metadata.protocolVersion !== gatewayProtocolVersion) {
    throw new GatewayProtocolError(metadata.protocolVersion, `gateway ${metadata.gatewayVersion}`)
  }
  return metadata
}

/** What a delegated call comes back as.
 *
 * `pending` is a first-class outcome rather than an error: the gateway froze
 * the call for a human, and the caller polls instead of blocking. Blocking
 * would hold a sandbox process open across a human's lunch break. */
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
  /** When the decision was handed back to the caller. A settled approval is
   *  delivered through `execute` exactly once; an identical call after that
   *  asks for a fresh decision rather than replaying an old one. */
  collectedAt: Schema.NullOr(Schema.String)
})
export type ApprovalRecord = typeof ApprovalRecord.Type

/** Public response contracts are schemas, not TypeScript-only promises. The
 * same contracts used to build gateway responses decode them here at
 * the client boundary. */
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
  /** What to call it. `slug` is accepted here and nowhere else: after this it
   *  is what every tool address and alias is made of. */
  slug: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String)
})
export type DiscoverIntegrationInput = typeof DiscoverIntegrationInput.Type

/** One tool as this key may actually call it.
 *
 *  `alias` is the gateway's own name for the connection behind the tool, and
 *  the only thing `execute` accepts. It is not derivable from the integration
 *  slug — a user-tier connection carries the subject it belongs to — so it is
 *  read from the gateway rather than reconstructed. */
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

const decodeOutcome = Schema.decodeUnknownSync(InvocationOutcome)
const decodeApproval = Schema.decodeUnknownSync(ApprovalRecord)
const decodeSearch = Schema.decodeUnknownSync(IntegrationSearchResponse)
const decodeDiscovery = Schema.decodeUnknownSync(IntegrationDiscovery)
const decodeIntegrations = Schema.decodeUnknownSync(GatewayIntegrationsResponse)
const decodeIntegrationTools = Schema.decodeUnknownSync(IntegrationToolsResponse)
const decodeIntegrationTool = Schema.decodeUnknownSync(Tool)
const decodeConnectionCreated = Schema.decodeUnknownSync(ConnectionCreated)
const decodeOAuthSession = Schema.decodeUnknownSync(OAuthSession)
const decodeConnections = Schema.decodeUnknownSync(ConnectionsResponse)
const decodeDisconnectedConnection = Schema.decodeUnknownSync(DisconnectedConnection)
const decodeValidation = Schema.decodeUnknownSync(IntegrationValidationReport)
const decodeIntegration = Schema.decodeUnknownSync(Integration)
const decodeEffectiveTools = Schema.decodeUnknownSync(EffectiveToolsResponse)
const isOutcome = Schema.is(InvocationOutcome)

export interface GatewayClient {
  readonly url: string

  metadata(): Promise<GatewayMetadata>

  search(input: RegistrySearchInput): Promise<IntegrationSearchResponse>
  discover(input: DiscoverIntegrationInput): Promise<IntegrationDiscovery>
  /** Changes an integration's display name. Its slug does not move. */
  renameIntegration(input: { readonly integration: string; readonly name: string }): Promise<Integration>
  integrations(): Promise<GatewayIntegrationsResponse>
  integrationTools(integration: string): Promise<IntegrationToolsResponse>
  integrationTool(input: IntegrationToolInput): Promise<Tool>
  /** What this key may call, and under which alias. */
  effectiveTools(): Promise<EffectiveToolsResponse>
  connect(input: CreateConnectionInput): Promise<ConnectionCreated>
  startOAuth(input: StartOAuthInput): Promise<OAuthSession>
  oauth(id: string): Promise<OAuthSession>
  connections(): Promise<ConnectionsResponse>
  disconnect(input: DisconnectInput): Promise<DisconnectedConnection>
  validate(input: ValidateInput): Promise<IntegrationValidationReport>

  /** Performs a delegated call.
   *
   *  Every authorization answer comes back as a value, `denied` and
   *  `failed` included: the gateway answered, and which answer it gave is the
   *  caller's to branch on. A thrown `GatewayError` means the gateway did not
   *  answer at all — bad key, no route, unreachable. */
  execute(input: {
    readonly alias: string
    readonly tool: string
    readonly arguments?: Json
  }): Promise<InvocationOutcome>
  approval(id: string): Promise<ApprovalRecord>
  health(): Promise<boolean>
}

export const createGatewayClient = (options: GatewayClientOptions): GatewayClient => {
  const doFetch = options.fetch ?? globalThis.fetch
  const base = options.url.replace(/\/+$/, "")
  let metadataRequest: Promise<GatewayMetadata> | undefined
  const metadata = (): Promise<GatewayMetadata> => {
    metadataRequest ??= readGatewayMetadata(base, doFetch)
    return metadataRequest
  }

  const send = async (
    method: string,
    path: string,
    body?: Json
  ): Promise<{ readonly ok: boolean; readonly status: number; readonly parsed: Json }> => {
    await metadata()
    const response = await doFetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        ...whenPresentMap("content-type", body, () => "application/json")
      },
      ...whenPresent("body", JSON.stringify(body))
    })
    const text = await response.text()
    return {
      ok: response.ok,
      status: response.status,
      parsed: text.trim().length === 0 ? {} : decodeJsonText(text)
    }
  }

  const failure = (method: string, path: string, status: number, parsed: Json): GatewayError => {
    // The gateway states a refusal in `error`; an authorization answer states it in
    // `reason`. Reading both is what keeps "alias not authorized" from being
    // reported as the generic "failed with 403".
    const message = Predicate.isObjectOrArray(parsed)
      ? "error" in parsed
        ? String(parsed["error"])
        : "reason" in parsed
        ? String(parsed["reason"])
        : `${method} ${path} failed with ${status}`
      : `${method} ${path} failed with ${status}`
    return new GatewayError(status, parsed, message)
  }

  const request = async (method: string, path: string, body?: Json): Promise<Json> => {
    const response = await send(method, path, body)
    if (!response.ok) throw failure(method, path, response.status, response.parsed)
    return response.parsed
  }

  return {
    url: base,
    metadata,
    search: async (input) => {
      const parameters = new URLSearchParams({
        q: input.query,
        limit: String(input.limit ?? 5)
      })
      if (input.kind !== undefined) parameters.set("kind", input.kind)
      return decodeSearch(await request("GET", `/v1/registry/search?${parameters.toString()}`))
    },
    discover: async (input) => decodeDiscovery(await request("POST", "/v1/integrations/discover", {
      url: input.url,
      ...whenPresent("connection", input.connection),
      ...whenPresent("slug", input.slug),
      ...whenPresent("name", input.name)
    })),
    renameIntegration: async (input) =>
      decodeIntegration(await request(
        "POST",
        `/v1/integrations/${encodeURIComponent(input.integration)}/name`,
        { name: input.name }
      )),
    integrations: async () => decodeIntegrations(await request("GET", "/v1/integrations")),
    effectiveTools: async () => decodeEffectiveTools(await request("GET", "/v1/tools")),
    integrationTools: async (integration) =>
      decodeIntegrationTools(
        await request("GET", `/v1/integrations/${encodeURIComponent(integration)}/tools`)
      ),
    integrationTool: async (input) => {
      const parameters = input.connection === undefined
        ? ""
        : `?connection=${encodeURIComponent(input.connection)}`
      return decodeIntegrationTool(await request(
        "GET",
        `/v1/integrations/${encodeURIComponent(input.integration)}/tools/${encodeURIComponent(input.tool)}${parameters}`
      ))
    },
    connect: async (input) => decodeConnectionCreated(await request("POST", "/v1/connections", {
      integration: input.integration,
      ...whenPresent("connection", input.connection),
      ...whenPresent("template", input.template),
      ...whenPresent("values", input.values)
    })),
    startOAuth: async (input) => decodeOAuthSession(await request("POST", "/v1/connections/oauth", {
      integration: input.integration,
      ...whenPresent("connection", input.connection),
      ...whenPresent("template", input.template),
      ...whenPresent("clientId", input.clientId),
      ...whenPresent("clientSecret", input.clientSecret),
      ...whenPresent("timeoutSeconds", input.timeoutSeconds)
    })),
    oauth: async (id) =>
      decodeOAuthSession(await request("GET", `/v1/connections/oauth/${encodeURIComponent(id)}`)),
    connections: async () => decodeConnections(await request("GET", "/v1/connections")),
    disconnect: async (input) =>
      decodeDisconnectedConnection(await request(
        "DELETE",
        `/v1/connections/${encodeURIComponent(input.integration)}/${encodeURIComponent(input.connection)}`
      )),
    validate: async (input) => decodeValidation(await request("POST", "/v1/validate", {
      node: input.node,
      ...whenPresent("live", input.live)
    })),
    execute: async (input) => {
      const response = await send("POST", "/v1/execute", {
        alias: input.alias,
        tool: input.tool,
        arguments: input.arguments ?? {}
      })
      // A denial and a vendor failure are answers, carried on 403 and 502 so
      // that HTTP callers see them too. They decode into the outcome union
      // rather than throwing, so one branch handles every authorization result.
      if (!response.ok && !isOutcome(response.parsed)) {
        throw failure("POST", "/v1/execute", response.status, response.parsed)
      }
      return decodeOutcome(response.parsed)
    },
    approval: async (id) => decodeApproval(await request("GET", `/v1/approvals/${id}`)),
    health: async () => {
      try {
        await metadata()
        return true
      } catch {
        return false
      }
    }
  }
}


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
