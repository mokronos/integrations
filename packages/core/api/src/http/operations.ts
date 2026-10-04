import { Data, Effect, Option, Schema } from "effect"
import type { Crypto } from "effect"
import type { HttpClient } from "effect/http"
import {
  Alias,
  aliasForConnection,
  ConnectionName,
  connectionRefOf,
  IntegrationSlug,
  ToolName,
  userOwner,
  whenPresent,
  whenPresentMap
} from "@integragents/contracts"
import type { ApprovalId, Json, Profile, ProfileId, SubjectId, TenantId } from "@integragents/contracts"
import { AuthTemplateSlug, Integrations, provisionIntegration, validateIntegrationNode } from "@integragents/host"
import type { IntegrationServices } from "@integragents/host"
import {
  boundToolAddress,
  deliverDueApprovalNotifications,
  forgetConnection,
  GatewayStoreService,
  includeConnectionTools
} from "@integragents/gateway-core"
import type { InvokeDependencies } from "@integragents/gateway-core"
import { capture, ErrorCapture } from "./observability.ts"
import { GatewayConfig } from "./services.ts"
import { OAuthFlowSessions } from "@integragents/gateway-core"

/** Everything a gateway operation may reach for, whichever surface invoked it. */
export type GatewayOperationServices =
  | GatewayStoreService
  | IntegrationServices
  | OAuthFlowSessions
  | GatewayConfig
  | ErrorCapture
  | Crypto.Crypto
  | HttpClient.HttpClient

/** The caller asked for something the gateway cannot do; HTTP spells the status, MCP the text. */
export class OperationRefused extends Data.TaggedError("OperationRefused")<{
  readonly status: "not-found" | "bad-request"
  readonly message: string
}> {}

const notFound = (message: string) => new OperationRefused({ status: "not-found", message })
const badRequest = (message: string) => new OperationRefused({ status: "bad-request", message })

export const requireSlug = (value: string): Effect.Effect<IntegrationSlug, OperationRefused> =>
  Option.match(Schema.decodeUnknownOption(IntegrationSlug)(value), {
    onNone: () => Effect.fail(notFound(`Unknown integration ${value}`)),
    onSome: Effect.succeed
  })

export const invokeDependencies: Effect.Effect<
  InvokeDependencies,
  never,
  GatewayStoreService | Integrations | OAuthFlowSessions | GatewayConfig | ErrorCapture
> = Effect.gen(function*() {
  const store = yield* GatewayStoreService
  const integrations = yield* Integrations
  const oauth = yield* OAuthFlowSessions
  const config = yield* GatewayConfig
  return {
    store,
    integrations,
    oauth,
    argumentRetentionDays: config.retentionDays,
    approvalUrlOf: (approvalId) => {
      const origin = config.dashboardUrl?.()
      return origin === undefined
        ? undefined
        : `${origin.replace(/\/+$/, "")}/approvals?approval=${encodeURIComponent(approvalId)}`
    },
    onApprovalCreated: () => capture(deliverDueApprovalNotifications({
      store,
      ...whenPresentMap("dashboardUrl", config.dashboardUrl?.(), (url) => url)
    }))
  }
})

const normalizeName = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, "")

type AuthMethodChoice = { readonly id: string; readonly template: string; readonly kind: string }

const selectAuthMethod = (
  methods: ReadonlyArray<AuthMethodChoice>,
  template: string | undefined
): AuthMethodChoice | undefined => {
  if (template !== undefined) {
    return methods.find((method) => method.template === template || method.id === template)
  }
  if (methods.length === 0) return { id: "none", template: "none", kind: "none" }
  if (methods.length === 1) return methods[0]
  return methods.find((method) => method.kind === "oauth") ?? methods[0]
}

/** Registers an integration. One that needs no credential is connected already, and joins the profiles that take new tools. */
export const discoverIntegration = Effect.fn("Gateway.discover")(function*(
  tenantId: TenantId,
  url: string,
  options: { readonly connection?: string; readonly slug?: string; readonly name?: string }
) {
  const store = yield* GatewayStoreService
  const integrations = yield* Integrations
  const connection = ConnectionName.make(options.connection ?? "default")
  const before = yield* capture(integrations.listConnections())
  const discovery = yield* provisionIntegration(url, options)
  const existed = before.some((entry) =>
    entry.owner === "org" && entry.integration === discovery.integration.slug && entry.name === connection)
  if (discovery.tools.length > 0 && !existed) {
    yield* capture(includeConnectionTools({
      store,
      integrations,
      tenantId,
      integration: discovery.integration.slug,
      connection
    }))
  }
  return discovery
})

const orgConnectionExists = Effect.fn("Gateway.orgConnectionExists")(function*(
  integration: IntegrationSlug,
  name: ConnectionName
) {
  const integrations = yield* Integrations
  const held = yield* capture(integrations.listConnections({ integration, owner: "org" }))
  return held.some((entry) => entry.name === name)
})

export const connectWithCredentials = Effect.fn("Gateway.connect")(function*(
  tenantId: TenantId,
  body: {
    readonly integration: string
    readonly connection?: string | undefined
    readonly template?: string | undefined
    readonly values?: Readonly<Record<string, string>> | undefined
    readonly subject?: SubjectId | undefined
  }
) {
  const store = yield* GatewayStoreService
  const integrations = yield* Integrations
  const slug = yield* requireSlug(body.integration)
  const found = yield* capture(integrations.findIntegration(slug))
  if (Option.isNone(found)) return yield* notFound(`Unknown integration ${body.integration}`)
  const integration = found.value
  const method = selectAuthMethod(integration.authMethods, body.template)
  if (method === undefined) {
    return yield* badRequest(
      `No auth template named "${body.template}" for ${integration.slug}. Available: ${
        integration.authMethods.map((candidate) => candidate.template).join(", ")
      }`
    )
  }
  if (method.kind === "oauth") {
    return yield* badRequest(`${integration.slug} uses OAuth; start it at POST /v1/connections/oauth`)
  }
  const values = body.values ?? {}
  const names = Object.keys(values)
  const name = ConnectionName.make(body.connection ?? "default")
  const fresh = body.subject === undefined && !(yield* orgConnectionExists(slug, name))
  const connection = yield* capture(integrations.createConnection({
    owner: body.subject === undefined ? "org" : userOwner(body.subject),
    integration: slug,
    name,
    template: AuthTemplateSlug.make(method.template),
    ...(names.length === 0
      ? { value: "" }
      : names.length === 1 && values["token"] !== undefined
        ? { value: values["token"] }
        : { values })
  }))
  if (fresh) {
    yield* capture(includeConnectionTools({ store, integrations, tenantId, integration: slug, connection: connection.name }))
  }
  const tools = yield* capture(integrations.toolSummaries({ integration: slug, connection: connection.name }))
  return { connection, tools }
})

export const startOAuthConnection = Effect.fn("Gateway.startOAuth")(function*(
  tenantId: TenantId,
  body: {
    readonly integration: string
    readonly connection?: string | undefined
    readonly template?: string | undefined
    readonly subject?: SubjectId | undefined
    readonly clientId?: string | undefined
    readonly clientSecret?: string | undefined
    readonly timeoutSeconds?: number | undefined
  }
) {
  const integrations = yield* Integrations
  const oauth = yield* OAuthFlowSessions
  const slug = yield* requireSlug(body.integration)
  const found = yield* capture(integrations.findIntegration(slug))
  if (Option.isNone(found)) return yield* notFound(`Unknown integration ${body.integration}`)
  const integration = found.value
  const method = integration.authMethods.find((candidate) =>
    body.template === undefined
      ? candidate.kind === "oauth"
      : candidate.template === body.template || candidate.id === body.template
  )
  if (method === undefined || method.kind !== "oauth") {
    return yield* badRequest(`${integration.slug} has no OAuth auth method`)
  }
  const connection = ConnectionName.make(body.connection ?? "default")
  return yield* oauth.start({
    integration: integration.slug,
    connection,
    authMethod: method,
    bindingTenant: tenantId,
    newConnection: body.subject === undefined && !(yield* orgConnectionExists(integration.slug, connection)),
    ...whenPresent("subject", body.subject),
    ...whenPresentMap("clientId", body.clientId, (id) => id),
    ...whenPresentMap("clientSecret", body.clientSecret, (secret) => secret),
    ...whenPresentMap(
      "timeoutMs",
      body.timeoutSeconds === undefined ? undefined : Math.max(1, body.timeoutSeconds) * 1000,
      (ms) => ms
    )
  }).pipe(Effect.mapError((failure) =>
    badRequest(`${body.integration} could not start an OAuth flow: ${failure.message}`)
  ))
})

export const removeConnectionByName = Effect.fn("Gateway.removeConnection")(function*(
  tenantId: TenantId,
  integration: string,
  requested: string
) {
  const store = yield* GatewayStoreService
  const integrations = yield* Integrations
  const connections = yield* capture(integrations.listConnections())
  const match = connections.find((connection) =>
    connection.integration === integration &&
    (connection.name === requested || normalizeName(connection.name) === normalizeName(requested))
  )
  if (match === undefined) {
    const known = connections
      .filter((connection) => connection.integration === integration)
      .map((connection) => connection.name)
    return yield* notFound(known.length === 0
      ? `${integration} has no connections`
      : `${integration} has no connection ${requested}. Known: ${known.join(", ")}`)
  }
  yield* capture(integrations.removeConnection({
    owner: match.owner,
    integration: match.integration,
    name: match.name
  }))
  yield* capture(forgetConnection({
    store,
    tenantId,
    connection: connectionRefOf(match.owner, match.integration, match.name)
  }))
  return { removed: true as const, integration, connection: match.name }
})

const GatewayNodeSource = Schema.Struct({
  source: Schema.Struct({
    kind: Schema.Literal("gateway"),
    alias: Schema.String,
    tool: Schema.String
  })
})

type Finding = { readonly severity: string; readonly check: string; readonly message: string }

const validateGatewayNode = Effect.fn("Gateway.validateGatewayNode")(function*(
  profileId: ProfileId | undefined,
  source: { readonly alias: string; readonly tool: string },
  live: boolean
) {
  const store = yield* GatewayStoreService
  const integrations = yield* Integrations
  const findings: Array<Finding> = []
  const aliasIsWellFormed = Schema.is(Alias)(source.alias)
  findings.push(
    aliasIsWellFormed
      ? { severity: "info", check: "structural", message: "Gateway integration reference is valid" }
      : {
        severity: "error",
        check: "structural",
        message: `Alias "${source.alias}" must be lowercase letters, digits, and underscores`
      }
  )

  if (aliasIsWellFormed && live) {
    const profileTools = profileId === undefined ? [] : yield* capture(store.listProfileTools(profileId))
    const accessTool = profileTools.find((tool) =>
      tool.tool === source.tool && aliasForConnection(tool.connection) === source.alias
    )
    if (profileId === undefined) {
      findings.push({
        severity: "error",
        check: "authorization",
        message: "Gateway aliases belong to a profile; validate this node with i and one of the profile's keys"
      })
    } else if (accessTool === undefined) {
      findings.push({
        severity: "error",
        check: "authorization",
        message: `${source.alias}.${source.tool} is not authorized for this key`
      })
    } else {
      findings.push({
        severity: "info",
        check: "authorization",
        message: `${source.alias}.${source.tool} resolves to ${accessTool.connection.integration}/${accessTool.connection.name}`
      })
      const address = boundToolAddress(accessTool.connection, ToolName.make(source.tool))
      const tools = yield* capture(integrations.listTools())
      findings.push(
        tools.some((candidate) => candidate.address === address)
          ? { severity: "info", check: "catalog", message: `${source.tool} is available` }
          : {
            severity: "error",
            check: "catalog",
            message: `${source.tool} is bound but no longer in the catalog: ${address}`
          }
      )
    }
  }

  return { ok: !findings.some((finding) => finding.severity === "error"), findings }
})

export const validateReference = Effect.fn("Gateway.validate")(function*(
  profileId: ProfileId | undefined,
  node: Json,
  live: boolean
) {
  if (Schema.is(GatewayNodeSource)(node)) {
    const source = Schema.decodeUnknownSync(GatewayNodeSource)(node).source
    return yield* validateGatewayNode(profileId, source, live)
  }
  return yield* capture(validateIntegrationNode(node, { live }))
})

/** A frozen call as its proposer may read it; other profiles' approvals do not exist for this one. */
export const findProfileApproval = Effect.fn("Gateway.findProfileApproval")(function*(
  profile: Profile,
  id: ApprovalId
) {
  const store = yield* GatewayStoreService
  const approval = yield* capture(store.getApproval(profile.tenantId, id))
  return approval === undefined || approval.profileId !== profile.id ? undefined : approval
})
