import { whenPresent, whenPresentMap } from "./optional.ts"
import { Predicate, Schema } from "effect"
import {
  ExecutorConnection,
  ExecutorTool,
  ExecutorToolSummary,
  IntegrationOverview
} from "@mokronos/integrations-executor/schemas"
import {
  IntegrationDiscovery,
  IntegrationValidationReport
} from "@mokronos/integrations-executor/integration-model"
import { IntegrationSearchResponse } from "@mokronos/integrations-executor/registry"

/** The client is deliberately dumb: authenticate, send, decode. Every decision
 * about whether a call may happen, which connection serves it, and whether a
 * human is asked lives behind the gateway.
 *
 * That is the point of the split — a sandbox holding this client holds no
 * authority beyond the grants attached to its key. */

export interface GatewayClientOptions {
  readonly url: string
  readonly apiKey: string
  /** Injected for tests, or to route through a proxy. */
  readonly fetch?: typeof globalThis.fetch
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

type Json = typeof Schema.Json.Type
const decodeJsonText = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))

export const GrantedTool = Schema.Struct({
  alias: Schema.String,
  tool: Schema.String,
  integration: Schema.String,
  decision: Schema.Literals(["allow", "require_approval"]),
  inputSchema: Schema.optional(Schema.Json),
  outputSchema: Schema.optional(Schema.Json)
})
export type GrantedTool = typeof GrantedTool.Type

const GrantedTools = Schema.Struct({ tools: Schema.Array(GrantedTool) })

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
    expiresAt: Schema.String
  }),
  Schema.Struct({ status: Schema.Literal("denied"), reason: Schema.String }),
  Schema.Struct({ status: Schema.Literal("failed"), message: Schema.String })
])
export type InvocationOutcome = typeof InvocationOutcome.Type

export const ApprovalRecord = Schema.Struct({
  id: Schema.String,
  alias: Schema.String,
  tool: Schema.String,
  status: Schema.Literals(["pending", "approved", "denied", "expired"]),
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
 * same Executor schemas used to build gateway responses decode them here at
 * the client boundary. */
export const GatewayIntegrationsResponse = Schema.Struct({
  integrations: Schema.Array(IntegrationOverview),
  oauthCallbackUrl: Schema.optional(Schema.NullOr(Schema.String))
})
export type GatewayIntegrationsResponse = typeof GatewayIntegrationsResponse.Type

export const IntegrationToolsResponse = Schema.Struct({
  tools: Schema.Array(ExecutorToolSummary)
})
export type IntegrationToolsResponse = typeof IntegrationToolsResponse.Type

export const ConnectionCreated = Schema.Struct({
  connection: ExecutorConnection,
  tools: Schema.Array(ExecutorToolSummary)
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
      connection: ExecutorConnection
    }),
    Schema.Struct({
      status: Schema.Literal("failed"),
      message: Schema.String
    })
  ])
})
export type OAuthSession = typeof OAuthSession.Type

export const ConnectionsResponse = Schema.Struct({
  connections: Schema.Array(ExecutorConnection)
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
  connection: Schema.optional(Schema.String)
})
export type DiscoverIntegrationInput = typeof DiscoverIntegrationInput.Type

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

const decodeGrantedTools = Schema.decodeUnknownSync(GrantedTools)
const decodeOutcome = Schema.decodeUnknownSync(InvocationOutcome)
const decodeApproval = Schema.decodeUnknownSync(ApprovalRecord)
const decodeSearch = Schema.decodeUnknownSync(IntegrationSearchResponse)
const decodeDiscovery = Schema.decodeUnknownSync(IntegrationDiscovery)
const decodeIntegrations = Schema.decodeUnknownSync(GatewayIntegrationsResponse)
const decodeIntegrationTools = Schema.decodeUnknownSync(IntegrationToolsResponse)
const decodeIntegrationTool = Schema.decodeUnknownSync(ExecutorTool)
const decodeConnectionCreated = Schema.decodeUnknownSync(ConnectionCreated)
const decodeOAuthSession = Schema.decodeUnknownSync(OAuthSession)
const decodeConnections = Schema.decodeUnknownSync(ConnectionsResponse)
const decodeDisconnectedConnection = Schema.decodeUnknownSync(DisconnectedConnection)
const decodeValidation = Schema.decodeUnknownSync(IntegrationValidationReport)
const isOutcome = Schema.is(InvocationOutcome)

export interface GatewayClient {
  readonly url: string

  search(input: RegistrySearchInput): Promise<IntegrationSearchResponse>
  discover(input: DiscoverIntegrationInput): Promise<IntegrationDiscovery>
  integrations(): Promise<GatewayIntegrationsResponse>
  integrationTools(integration: string): Promise<IntegrationToolsResponse>
  integrationTool(input: IntegrationToolInput): Promise<ExecutorTool>
  connect(input: CreateConnectionInput): Promise<ConnectionCreated>
  startOAuth(input: StartOAuthInput): Promise<OAuthSession>
  oauth(id: string): Promise<OAuthSession>
  connections(): Promise<ConnectionsResponse>
  disconnect(input: DisconnectInput): Promise<DisconnectedConnection>
  validate(input: ValidateInput): Promise<IntegrationValidationReport>

  /** The tools this key can reach. Grant-scoped, so an ungranted tool is
   *  absent rather than present-and-failing.
   *
   *  Schemas are opt-in because they cost a catalog read per grant. */
  tools(options?: { readonly schemas?: boolean }): Promise<ReadonlyArray<GrantedTool>>

  /** Performs a delegated call.
   *
   *  Every answer the *policy* produced comes back as a value, `denied` and
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

  const send = async (
    method: string,
    path: string,
    body?: Json
  ): Promise<{ readonly ok: boolean; readonly status: number; readonly parsed: Json }> => {
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
    // The gateway states a refusal in `error`; a policy answer states it in
    // `reason`. Reading both is what keeps "alias not granted" from being
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

  const query = (schemas: boolean | undefined): string => schemas === true ? "?schemas=true" : ""

  return {
    url: base,
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
      ...whenPresent("connection", input.connection)
    })),
    integrations: async () => decodeIntegrations(await request("GET", "/v1/integrations")),
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
    tools: async (options) =>
      decodeGrantedTools(await request("GET", `/v1/tools${query(options?.schemas)}`)).tools,
    execute: async (input) => {
      const response = await send("POST", "/v1/execute", {
        alias: input.alias,
        tool: input.tool,
        arguments: input.arguments ?? {}
      })
      // A denial and a vendor failure are answers, carried on 403 and 502 so
      // that HTTP callers see them too. They decode into the outcome union
      // rather than throwing, so one branch handles every policy result.
      if (!response.ok && !isOutcome(response.parsed)) {
        throw failure("POST", "/v1/execute", response.status, response.parsed)
      }
      return decodeOutcome(response.parsed)
    },
    approval: async (id) => decodeApproval(await request("GET", `/v1/approvals/${id}`)),
    health: async () => {
      try {
        await request("GET", "/v1/health")
        return true
      } catch {
        return false
      }
    }
  }
}

export {
  defaultGatewayPort,
  GatewayConfigFile,
  gatewayConfigPath,
  integrationsHome,
  readGatewayConfig,
  resolveClientConnection,
  writeGatewayConfig
} from "./config.ts"
export type { ClientConnection } from "./config.ts"

export {
  ExecutorConnection,
  ExecutorTool,
  ExecutorToolSummary,
  IntegrationDiscovery,
  IntegrationOverview,
  IntegrationSearchResponse,
  IntegrationValidationReport
}

export {
  bindingName,
  generateEffectModule,
  generateModule,
  generateTypeScriptModule,
  typeName
} from "./codegen.ts"
export type { CodegenTarget, GeneratableTool } from "./codegen.ts"
