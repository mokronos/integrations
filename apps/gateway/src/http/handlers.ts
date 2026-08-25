import { Effect, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import type { IntegrationsApi } from "@mokronos/integration-host"
import { searchIntegrations } from "@mokronos/integration-host"
import {
  gatewayProtocolVersion,
  whenPresent,
  whenPresentMap
} from "@mokronos/contracts"
import {
  Alias,
  ApprovalId,
  ClientId,
  ConnectionName,
  IntegrationSlug,
  LoginHandoffHash,
  SubjectId,
  TenantId,
  ToolName
} from "../domain.ts"
import { deliverApprovalNotification } from "../approval-delivery.ts"
import { refreshIntegrationSnapshot } from "../drift.ts"
import { runMaintenance } from "../maintenance.ts"
import { executeAuthorized, grantToolAddress, invokeThroughGateway, listGrantedTools } from "../invoke.ts"
import {
  generateApiKey,
  generateLoginHandoff,
  hashLoginHandoff,
  newClientId,
  newGrantId,
  newSubjectId,
  newTenantId
} from "../keys.ts"
import { generateSessionToken, hashPassword, verifyPassword } from "../passwords.ts"
import type { OAuthSessions } from "../oauth-sessions.ts"
import type { GoogleIdentityOAuth } from "../identity-oauth.ts"
import {
  googleIdentityAuthorizationUrl,
  googleIdentityCallbackUrl,
  resolveGoogleIdentity
} from "../identity-oauth.ts"
import { oauthBrowserPage } from "../oauth.ts"
import type { GatewayStore } from "../store.ts"
import type { WebAssets } from "../web-assets.ts"
import { gatewayVersion } from "../version.ts"
import {
  clearedSessionCookieHeaderValue,
  decidedBy,
  Forbidden,
  Identity,
  requireClient,
  requireSecret,
  requireTenant,
  sessionCookieHeaderValue
} from "./authority.ts"
import {
  ApiBadRequest,
  ApiNotFound,
  ApiNotImplemented,
  HandoffCollected,
  HandoffExpired,
  HandoffUnknown,
  InvalidCredentials,
  PasswordRequired,
  SignupClosed,
  GatewayApi
} from "./api.ts"

/** Handlers for every endpoint in {@link GatewayApi}. Each group layer closes
 *  over plain dependency values and bridges to the existing async domain code;
 *  those bridges shrink as the domain and store become Effects themselves. */

export interface SessionDependencies {
  /** Whether POST /v1/auth/signup may create a new tenant. True while the
   *  gateway has no logins at all (so its first human can claim it) and after
   *  that only when an operator opts in. */
  readonly signupOpen: () => Promise<boolean>
  /** Set on session cookies when the gateway is served over TLS. */
  readonly secureCookies: boolean
  readonly sessionTtlHours?: number
  /** Human sign-in through Google. Deliberately separate from integration
   *  OAuth, which authorizes tools rather than operators. */
  readonly google?: GoogleIdentityOAuth
}

export interface GatewayDependencies {
  readonly store: GatewayStore
  readonly integrations: IntegrationsApi
  readonly retentionDays: number
  readonly oauth: OAuthSessions
  /** Where a provider must redirect after the human approves, so clients can
   *  show it before a flow starts — providers like Google and Microsoft want
   *  this exact URI registered in their consoles up front. */
  readonly oauthCallbackUrl?: () => string | undefined
  /** Origin of the authenticated control plane, used only to point a human at
   *  a pending approval. */
  readonly dashboardUrl?: () => string | undefined
  /** Overrides the public registry for an isolated deployment or acceptance test. */
  readonly registryUrl?: string
  readonly sessions?: SessionDependencies
}

const json = (
  status: number,
  body: JsonValue,
  headers?: Readonly<Record<string, string>>
): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.jsonUnsafe(body, {
    status,
    ...whenPresentMap("headers", headers, (h) => h)
  })

type JsonValue = { readonly [key: string]: JsonScalar | ReadonlyArray<JsonValue> | JsonValue }

type JsonScalar = string | number | boolean | null

const page = (
  status: number,
  content: { readonly title: string; readonly message: string },
  headers?: Readonly<Record<string, string>>
): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.text(oauthBrowserPage(content), {
    status,
    contentType: "text/html; charset=utf-8",
    ...whenPresentMap("headers", headers, (h) => h)
  })

/** Compares connection names the way a human means them. The host stores a
 *  normalised name (`docs-demo` becomes `docsDemo`), and rather than reproduce
 *  that transformation — which belongs to the host and may change — this
 *  compares the parts a separator convention cannot alter. */
const normalizeName = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, "")

const positiveInt = (value: string | undefined, fallback: number): number => {
  if (value === undefined) return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const nonNegativeInt = (value: string | undefined, fallback: number): number => {
  if (value === undefined) return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

/** The login surface's failures do not distinguish "unknown email" from "wrong
 *  password". The difference is an enumeration oracle for anyone harvesting
 *  credentials, and the human who needs to know already knows which one it
 *  was. */
const verifyLoginPassword = async (
  store: GatewayStore,
  email: string,
  password: string
): Promise<
  | { readonly accepted: false }
  | {
    readonly accepted: true
    readonly login: NonNullable<Awaited<ReturnType<GatewayStore["findLoginByEmail"]>>>
  }
> => {
  const login = await store.findLoginByEmail(email)
  const accepted = login?.passwordHash !== null && login?.passwordHash !== undefined &&
    await verifyPassword(password, login.passwordHash)
  return !accepted || login === undefined
    ? { accepted: false }
    : { accepted: true, login }
}

const safeReturnPath = (candidate: string | undefined): string | null => {
  if (candidate === undefined || !candidate.startsWith("/")) return null
  const base = "https://gateway.invalid"
  const resolved = new URL(candidate, base)
  return resolved.origin === base
    ? `${resolved.pathname}${resolved.search}${resolved.hash}`
    : null
}

// --- system -----------------------------------------------------------------

export const SystemLayer = HttpApiBuilder.group(GatewayApi, "system", (handlers) =>
  handlers
    .handle("health", () => Effect.succeed({ ok: true }))
    .handle("metadata", () =>
      // Health checks are liveness noise; this one response is the only place
      // a no-store cache policy still matters on the read path.
      Effect.succeed(json(
        200,
        { ok: true, protocolVersion: gatewayProtocolVersion, gatewayVersion },
        { "cache-control": "no-store" }
      ))))

// --- fallback ---------------------------------------------------------------

interface EndpointRoute {
  readonly method: string
  readonly path: string
}

const endpointRoutes: ReadonlyArray<EndpointRoute> = Object.values(GatewayApi.groups).flatMap((group) =>
  Object.values(group.endpoints).map((endpoint) => ({
    method: endpoint.method,
    path: endpoint.path
  } satisfies EndpointRoute))
)

const segmentsOf = (value: string): ReadonlyArray<string> =>
  value.split("/").filter((segment) => segment.length > 0)

const matchesPattern = (pattern: string, pathname: string): boolean => {
  const expected = segmentsOf(pattern)
  const actual = segmentsOf(pathname)
  if (expected.length !== actual.length) return false
  return expected.every((part, index) =>
    part.startsWith(":") || part === actual[index]
  )
}

const pathIsKnown = (pathname: string): boolean =>
  endpointRoutes.some((route) => route.path !== "/*" && matchesPattern(route.path, pathname))

const unmatched = (webAssets: WebAssets | undefined) =>
  Effect.gen(function*() {
    const request = yield* HttpServerRequest.HttpServerRequest
    // Platform requests may carry either a full URL or a path with search.
    const rawUrl = request.url
    const pathname = rawUrl.startsWith("/")
      ? rawUrl.split("?")[0] ?? rawUrl
      : new URL(rawUrl).pathname
    const method = request.method === "HEAD" ? "GET" : request.method
    if (webAssets !== undefined && method === "GET" && !pathname.startsWith("/v1/")) {
      const asset = yield* Effect.promise(() => webAssets.respond(pathname))
      if (asset !== undefined) return HttpServerResponse.fromWeb(asset)
    }
    if (pathIsKnown(pathname)) {
      return json(405, { error: `${request.method} is not allowed on ${pathname}` })
    }
    return json(404, { error: `No route for ${request.method} ${pathname}` })
  })

/** Serves the control plane's own files for any unmatched non-`/v1` path.
 *  Absent on headless deployments, where such paths answer 404 JSON. */
export const FallbackLayer = (options: {
  readonly webAssets?: WebAssets
}) =>
  HttpApiBuilder.group(GatewayApi, "fallback", (handlers) =>
    handlers
      .handle("unmatchedGet", () => unmatched(options.webAssets))
      .handle("unmatchedPost", () => unmatched(undefined))
      .handle("unmatchedDelete", () => unmatched(undefined)))

// --- delegated --------------------------------------------------------------

export const DelegatedLayer = (dependencies: {
  readonly store: GatewayStore
  readonly integrations: IntegrationsApi
  readonly retentionDays: number
  readonly dashboardUrl?: () => string | undefined
}) =>
  HttpApiBuilder.group(GatewayApi, "delegated", (handlers) =>
    handlers
      .handle("listTools", (request) =>
        Effect.gen(function*() {
          const client = yield* requireClient
          return {
            tools: yield* Effect.promise(() =>
              listGrantedTools(dependencies.store, client.id, {
                schemas: request.query["schemas"] === "true",
                integrations: dependencies.integrations
              }))
          }
        }))
      .handle("execute", (request) =>
        Effect.gen(function*() {
          const secret = yield* requireSecret
          return yield* Effect.promise(() =>
            invokeThroughGateway(
              {
                store: dependencies.store,
                integrations: dependencies.integrations,
                argumentRetentionDays: dependencies.retentionDays,
                approvalUrlOf: (approvalId) => {
                  const origin = dependencies.dashboardUrl?.()
                  return origin === undefined
                    ? undefined
                    : `${origin.replace(/\/+$/, "")}/approvals?approval=${encodeURIComponent(approvalId)}`
                },
                onApprovalCreated: async (input) => await deliverApprovalNotification({
                  client: input.authorization.client,
                  approvalId: input.approvalId,
                  alias: input.authorization.grant.alias,
                  tool: input.authorization.grant.tool,
                  expiresAt: input.expiresAt,
                  ...whenPresentMap("approvalUrl", input.approvalUrl, (url) => url)
                })
              },
              {
                secret,
                alias: request.payload.alias,
                tool: ToolName.make(request.payload.tool),
                arguments: request.payload.arguments ?? {}
              }
            ))
        }))
      .handle("approval", (request) =>
        Effect.gen(function*() {
          const id = ApprovalId.make(request.params["id"])
          const client = yield* requireClient
          const approval = yield* Effect.promise(() =>
            dependencies.store.getApproval(client.tenantId, id))
          // Scoped to the caller: one client must not read another's frozen call.
          if (approval === undefined || approval.clientId !== client.id) {
            return yield* new ApiNotFound({ error: `Unknown approval ${id}` })
          }
          return approval
        })))

// --- provisioning -----------------------------------------------------------

/** Picks the auth method a connect request should use, preferring an explicit
 *  template and otherwise the integration's only sensible option. */
const selectAuthMethod = (
  methods: ReadonlyArray<{ readonly id: string; readonly template: string; readonly kind: string }>,
  template: string | undefined
): { readonly id: string; readonly template: string; readonly kind: string } | undefined => {
  if (template !== undefined) {
    return methods.find((method) => method.template === template || method.id === template)
  }
  if (methods.length === 0) return { id: "none", template: "none", kind: "none" }
  if (methods.length === 1) return methods[0]
  return methods.find((method) => method.kind === "oauth") ?? methods[0]
}

export const ProvisioningLayer = (dependencies: {
  readonly store: GatewayStore
  readonly integrations: IntegrationsApi
  readonly oauth: OAuthSessions
  readonly oauthCallbackUrl?: () => string | undefined
  readonly registryUrl?: string
}) =>
  HttpApiBuilder.group(GatewayApi, "provisioning", (handlers) =>
    handlers
      .handle("listIntegrations", () =>
        Effect.gen(function*() {
          const integrations = yield* Effect.promise(() =>
            dependencies.integrations.listIntegrationOverviews())
          return {
            integrations,
            ...whenPresentMap("oauthCallbackUrl", dependencies.oauthCallbackUrl?.(), (url) => url)
          }
        }))
      .handle("discover", (request) =>
        Effect.promise(() =>
          dependencies.integrations.provisioning.provision(
            request.payload.url,
            request.payload.connection === undefined
              ? {}
              : { connection: request.payload.connection }
          )))
      .handle("integrationTools", (request) =>
        Effect.map(
          Effect.promise(() =>
            dependencies.integrations.tools.summaries({ integration: request.params["slug"] })),
          (tools) => ({ tools })
        ))
      .handle("describeTool", (request) =>
        Effect.promise(() =>
          dependencies.integrations.tools.describe({
            integration: request.params["slug"],
            name: request.params["tool"],
            ...whenPresentMap("connection", request.query["connection"], (c) => c)
          })))
      .handle("registrySearch", (request) =>
        Effect.promise(() =>
          searchIntegrations(
            {
              q: request.query["q"],
              limit: positiveInt(request.query["limit"], 5),
              ...whenPresentMap("kind", request.query["kind"], (k) => k)
            },
            whenPresent("registryUrl", dependencies.registryUrl)
          )))
      .handle("invokeTool", (request) =>
        // Administrative, and deliberately not grant-checked: a client that may
        // mutate grants could grant itself this tool in one extra call, so a
        // check here would be friction rather than a control. The delegated
        // surface has no address form at all. See docs/adr/0002.
        Effect.promise(() =>
          dependencies.integrations.tools.execute(
            request.payload.address,
            request.payload.arguments ?? {}
          )))
      .handle("validate", (request) =>
        Effect.gen(function*() {
          const body = request.payload
          const isGatewayNode = Schema.is(GatewayNodeSource)
          if (isGatewayNode(body.node)) {
            const caller = yield* Identity
            const clientId = caller.kind === "client" || caller.kind === "local"
              ? caller.client.id
              : undefined
            const source = Schema.decodeUnknownSync(GatewayNodeSource)(body.node).source
            return yield* Effect.promise(() =>
              validateGatewayNode(
                { store: dependencies.store, integrations: dependencies.integrations },
                clientId,
                source,
                body.live ?? true
              ))
          }
          return yield* Effect.promise(() =>
            dependencies.integrations.validateIntegrationNode(body.node, { live: body.live ?? true }))
        }))
      .handle("listConnections", () =>
        Effect.map(
          Effect.promise(() => dependencies.integrations.connections.list()),
          (connections) => ({ connections })
        ))
      .handle("connect", (request) =>
        Effect.gen(function*() {
          const body = request.payload
          const integration = yield* Effect.promise(() =>
            dependencies.integrations.catalog.find(body.integration))
          if (integration === undefined) {
            return yield* new ApiNotFound({ error: `Unknown integration ${body.integration}` })
          }
          const method = selectAuthMethod(integration.authMethods, body.template)
          if (method === undefined) {
            return yield* new ApiBadRequest({
              error: `No auth template named "${body.template}" for ${integration.slug}. Available: ${
                integration.authMethods.map((candidate) => candidate.template).join(", ")
              }`
            })
          }
          if (method.kind === "oauth") {
            return yield* new ApiBadRequest({
              error: `${integration.slug} uses OAuth; start it at POST /v1/connections/oauth`
            })
          }
          const values = body.values ?? {}
          const names = Object.keys(values)
          const connection = yield* Effect.promise(() =>
            dependencies.integrations.connections.create({
              integration: integration.slug,
              name: body.connection ?? "default",
              template: method.template,
              ...(names.length === 0
                ? { value: "" }
                : names.length === 1 && values["token"] !== undefined
                ? { value: values["token"] }
                : { values })
            }))
          return {
            connection,
            tools: yield* Effect.promise(() =>
              dependencies.integrations.tools.summaries({
                integration: integration.slug,
                connection: connection.name
              }))
          }
        }))
      .handle("startOAuth", (request) =>
        Effect.gen(function*() {
          const body = request.payload
          const integration = yield* Effect.promise(() =>
            dependencies.integrations.catalog.find(body.integration))
          if (integration === undefined) {
            return yield* new ApiNotFound({ error: `Unknown integration ${body.integration}` })
          }
          const method = integration.authMethods.find((candidate) =>
            body.template === undefined
              ? candidate.kind === "oauth"
              : candidate.template === body.template || candidate.id === body.template
          )
          if (method === undefined || method.kind !== "oauth") {
            return yield* new ApiBadRequest({ error: `${integration.slug} has no OAuth auth method` })
          }
          // The gateway drives the flow and hosts the callback, because it is
          // what holds credentials. The caller opens a browser and polls.
          return yield* Effect.promise(() =>
            dependencies.oauth.start({
              integration: integration.slug,
              connection: body.connection ?? "default",
              authMethod: method,
              ...whenPresentMap("clientId", body.clientId, (id) => id),
              ...whenPresentMap("clientSecret", body.clientSecret, (secret) => secret),
              ...whenPresentMap(
                "timeoutMs",
                body.timeoutSeconds === undefined
                  ? undefined
                  : Math.max(1, body.timeoutSeconds) * 1000,
                (ms) => ms
              )
            }))
        }))
      .handle("oauthSession", (request) =>
        Effect.gen(function*() {
          const session = yield* Effect.promise(() => dependencies.oauth.get(request.params["id"]))
          if (session === undefined) {
            return yield* new ApiNotFound({ error: "Unknown or expired OAuth session" })
          }
          return session
        }))
      .handle("oauthCallback", (request) =>
        Effect.gen(function*() {
          const state = request.query["state"]
          const code = request.query["code"]
          const errorDescription = request.query["error_description"] ?? request.query["error"]
          if (state === undefined || code === undefined || errorDescription !== undefined) {
            return page(400, {
              title: "Authorization failed",
              message: errorDescription ?? "The provider did not return a usable authorization code."
            })
          }
          const completed = yield* Effect.promise(() =>
            dependencies.oauth.completeByState(state, {
              code,
              ...whenPresentMap("callbackDomain", request.query["domain"] ?? request.query["site"], (d) => d)
            }))
          if (completed === undefined) {
            return page(400, {
              title: "Unknown authorization",
              message:
                "This callback does not match any authorization in progress. Return to the terminal or dashboard and start again."
            })
          }
          if (completed.state.status === "failed") {
            return page(400, {
              title: "Authorization failed",
              message: completed.state.message
            })
          }
          return page(200, {
            title: "Account connected",
            message: `${completed.integration} was connected. You can close this window.`
          })
        }))
      .handle("removeConnection", (request) =>
        Effect.gen(function*() {
          const integration = request.params["integration"]
          const requested = request.params["name"]
          // Connection names are normalised on the way in (`docs-demo` is
          // stored as `docsDemo`), so removing one by the name you typed has
          // to resolve through the same normalisation. Otherwise a connection
          // you just made cannot be deleted by the name you made it with.
          const connections = yield* Effect.promise(() =>
            dependencies.integrations.connections.list())
          const match = connections.find((connection) =>
            connection.integration === integration &&
            (connection.name === requested ||
              normalizeName(connection.name) === normalizeName(requested))
          )
          if (match === undefined) {
            const known = connections
              .filter((connection) => connection.integration === integration)
              .map((connection) => connection.name)
            return yield* new ApiNotFound({
              error: known.length === 0
                ? `${integration} has no connections`
                : `${integration} has no connection ${requested}. Known: ${known.join(", ")}`
            })
          }
          yield* Effect.promise(() =>
            dependencies.integrations.connections.remove({ integration, name: match.name }))
          return { removed: true as const, integration, connection: match.name }
        })))

const GatewayNodeSource = Schema.Struct({
  source: Schema.Struct({
    kind: Schema.Literal("gateway"),
    alias: Schema.String,
    tool: Schema.String
  })
})

/** Answers the question a workflow author is actually asking: will this step
 *  resolve when it runs, as *this* caller? An alias is not a name in the
 *  catalog — it is a binding held by a grant — so structural validity and
 *  reachability are separate findings. */
const validateGatewayNode = (
  dependencies: {
    readonly store: GatewayStore
    readonly integrations: Pick<IntegrationsApi, "tools">
  },
  clientId: ClientId | undefined,
  source: { readonly alias: string; readonly tool: string },
  live: boolean
): Promise<{
  readonly ok: boolean
  readonly findings: ReadonlyArray<
    { readonly severity: string; readonly check: string; readonly message: string }
  >
}> =>
  Effect.runPromise(Effect.gen(function*() {
    const findings: Array<{ severity: string; check: string; message: string }> = []
    const aliasIsWellFormed = /^[a-z][a-z0-9-]*$/.test(source.alias)
    findings.push(
      aliasIsWellFormed
        ? { severity: "info", check: "structural", message: "Gateway integration reference is valid" }
        : {
          severity: "error",
          check: "structural",
          message: `Alias "${source.alias}" must be lowercase letters, digits, and dashes`
        }
    )

    if (aliasIsWellFormed && live) {
      const grants = clientId === undefined
        ? []
        : yield* Effect.promise(() => dependencies.store.listGrants(clientId))
      const grant = grants.find((candidate) =>
        candidate.alias === source.alias && candidate.tool === source.tool
      )
      if (clientId === undefined) {
        findings.push({
          severity: "error",
          check: "grant",
          message: "Gateway aliases are client-specific; validate this node with i and its client key"
        })
      } else if (grant === undefined) {
        findings.push({
          severity: "error",
          check: "grant",
          // Naming the alias but not what else it exposes: a validation report
          // is not a place to enumerate a caller's other capabilities.
          message: `${source.alias}.${source.tool} is not granted to this key`
        })
      } else {
        findings.push({
          severity: "info",
          check: "grant",
          message: `${source.alias}.${source.tool} resolves to ${grant.connection.integration}/${grant.connection.name}${
            grant.decision === "require_approval" ? " and is frozen for a human" : ""
          }`
        })
        const address = grantToolAddress(grant.connection, ToolName.make(source.tool))
        const tools = yield* Effect.promise(() => dependencies.integrations.tools.list())
        findings.push(
          tools.some((candidate) => candidate.address === address)
            ? { severity: "info", check: "catalog", message: `${source.tool} is available` }
            : {
              severity: "error",
              check: "catalog",
              message: `${source.tool} is granted but no longer in the catalog: ${address}`
            }
        )
      }
    }

    return { ok: !findings.some((finding) => finding.severity === "error"), findings }
  }))

// --- administrative ---------------------------------------------------------

export const AdministrativeLayer = (dependencies: {
  readonly store: GatewayStore
  readonly integrations: IntegrationsApi
  readonly retentionDays: number
}) =>
  HttpApiBuilder.group(GatewayApi, "administrative", (handlers) =>
    handlers
      .handle("overview", () =>
        Effect.gen(function*() {
          const tenantId = yield* requireTenant
          const [counts, connections, recentActivity] = yield* Effect.all([
            Effect.promise(() => dependencies.store.overviewCounts(tenantId)),
            Effect.promise(() => dependencies.integrations.connections.list()),
            Effect.promise(() => dependencies.store.listAudit(tenantId, { limit: 5, offset: 0 }))
          ])
          return { ...counts, connections: connections.length, recentActivity }
        }))
      .handle("listClients", () =>
        Effect.gen(function*() {
          const tenantId = yield* requireTenant
          return {
            clients: yield* Effect.promise(() => dependencies.store.listClients(tenantId))
          }
        }))
      .handle("createClient", (request) =>
        Effect.gen(function*() {
          const tenantId = yield* requireTenant
          const body = request.payload
          if ((yield* Effect.promise(() =>
            dependencies.store.findClientByName(tenantId, body.name))) !== undefined) {
            return yield* new ApiBadRequest({ error: `A client named ${body.name} already exists` })
          }
          // Clients are created inside the caller's partition. There is no way
          // to provision into another tenant over this surface, by design.
          return yield* Effect.promise(() =>
            dependencies.store.createClient({
              id: newClientId(),
              tenantId,
              name: body.name,
              capabilities: body.capabilities ?? [],
              ...whenPresentMap("approvalDelivery", body.approvalDelivery, (d) => d)
            }))
        }))
      .handle("updateClientSettings", (request) =>
        Effect.gen(function*() {
          const tenantId = yield* requireTenant
          const clientId = request.params["id"]
          const existing = yield* Effect.promise(() =>
            dependencies.store.findClientById(tenantId, clientId))
          if (existing === undefined) {
            return yield* new ApiNotFound({ error: `Unknown client ${clientId}` })
          }
          if (existing.revokedAt !== null) {
            return yield* new ApiBadRequest({ error: `Client ${clientId} is revoked` })
          }
          return yield* Effect.promise(() =>
            dependencies.store.updateClientSettings({
              tenantId,
              id: clientId,
              capabilities: request.payload.capabilities,
              approvalDelivery: request.payload.approvalDelivery
            }))
        }))
      .handle("issueKey", (request) =>
        Effect.gen(function*() {
          const tenantId = yield* requireTenant
          const clientId = request.params["id"]
          if ((yield* Effect.promise(() =>
            dependencies.store.findClientById(tenantId, clientId))) === undefined) {
            return yield* new ApiNotFound({ error: `Unknown client ${clientId}` })
          }
          const key = generateApiKey()
          yield* Effect.promise(() =>
            dependencies.store.addApiKey({ id: key.id, clientId, hash: key.hash }))
          // The only time the plaintext exists outside the caller's hands.
          return { id: key.id, clientId, secret: key.secret }
        }))
      .handle("listKeys", (request) =>
        Effect.gen(function*() {
          const tenantId = yield* requireTenant
          const clientId = request.params["id"]
          if ((yield* Effect.promise(() =>
            dependencies.store.findClientById(tenantId, clientId))) === undefined) {
            return yield* new ApiNotFound({ error: `Unknown client ${clientId}` })
          }
          // Hashes stay behind the gateway. What an operator needs is which keys
          // exist, when each was last used, and which are still live.
          const keys = yield* Effect.promise(() => dependencies.store.listApiKeys(clientId))
          return {
            keys: keys.map((key) => ({
              id: key.id,
              clientId: key.clientId,
              createdAt: key.createdAt,
              lastUsedAt: key.lastUsedAt,
              revokedAt: key.revokedAt
            }))
          }
        }))
      .handle("revokeKey", (request) =>
        Effect.gen(function*() {
          const keyId = request.params["id"]
          yield* Effect.promise(() => dependencies.store.revokeApiKey(keyId))
          // Rotation, not containment: a revoked key's frozen calls stay armed
          // because the client behind them is still trusted. Revoking the
          // client is what cancels those.
          return { revoked: true as const, key: keyId }
        }))
      .handle("clientTools", (request) =>
        Effect.gen(function*() {
          const tenantId = yield* requireTenant
          const clientId = request.params["id"]
          if ((yield* Effect.promise(() =>
            dependencies.store.findClientById(tenantId, clientId))) === undefined) {
            return yield* new ApiNotFound({ error: `Unknown client ${clientId}` })
          }
          // The same listing `/v1/tools` gives a key about itself, asked about
          // someone else. Generating bindings for the client you are
          // provisioning should not require holding its key.
          return {
            tools: yield* Effect.promise(() =>
              listGrantedTools(dependencies.store, clientId, {
                schemas: request.query["schemas"] === "true",
                integrations: dependencies.integrations
              }))
          }
        }))
      .handle("revokeClient", (request) =>
        Effect.gen(function*() {
          const tenantId = yield* requireTenant
          const clientId = request.params["id"]
          if ((yield* Effect.promise(() =>
            dependencies.store.findClientById(tenantId, clientId))) === undefined) {
            return yield* new ApiNotFound({ error: `Unknown client ${clientId}` })
          }
          yield* Effect.promise(() => dependencies.store.revokeClient(tenantId, clientId))
          // Revoking a client is done because something is wrong, so its frozen
          // actions must not stay armed. Revoking a single key does not do this.
          const cancelled = yield* Effect.promise(() =>
            dependencies.store.cancelApprovalsForClient(clientId))
          return { revoked: true as const, cancelledApprovals: cancelled }
        }))
      .handle("listGrants", (request) =>
        Effect.map(
          Effect.promise(() => dependencies.store.listGrants(request.query["clientId"])),
          (grants) => ({ grants })
        ))
      .handle("createGrant", (request) =>
        Effect.gen(function*() {
          const tenantId = yield* requireTenant
          const body = request.payload
          const clientId = body.clientId
          if ((yield* Effect.promise(() =>
            dependencies.store.findClientById(tenantId, clientId))) === undefined) {
            return yield* new ApiNotFound({ error: `Unknown client ${clientId}` })
          }
          if (body.connection.owner === "user") {
            // The wire contract keeps the user tier because that is where the
            // design is going, but nothing can create a user-tier *connection*
            // yet, so such a grant resolves to an address that does not exist.
            // A grant that can only fail at invoke time is worse than a refusal
            // here.
            return yield* new ApiBadRequest({
              error:
                "User-tier connections do not exist yet, so a user-tier grant cannot resolve. Grant against an org connection."
            })
          }
          const summaries = yield* Effect.promise(() =>
            dependencies.integrations.tools.summaries({ integration: body.connection.integration }))
          const tool = summaries.find((candidate) =>
            candidate.name === body.tool &&
            candidate.owner === "org" &&
            normalizeName(candidate.connection) === normalizeName(body.connection.name)
          )
          if (tool === undefined) {
            return yield* new ApiNotFound({
              error: `Unknown connected tool ${body.connection.integration}/${body.connection.name}/${body.tool}`
            })
          }
          return yield* Effect.promise(() =>
            dependencies.store.createGrant({
              id: newGrantId(),
              tenantId,
              clientId,
              alias: body.alias,
              tool: ToolName.make(body.tool),
              connection: {
                owner: "org" as const,
                integration: IntegrationSlug.make(tool.integration),
                name: ConnectionName.make(tool.connection)
              },
              decision: body.decision ?? tool.defaultDecision
            }))
        }))
      .handle("revokeGrant", (request) =>
        Effect.gen(function*() {
          const tenantId = yield* requireTenant
          yield* Effect.promise(() =>
            dependencies.store.revokeGrant(tenantId, request.params["id"]))
          return { revoked: true as const }
        }))
      .handle("listApprovals", (request) =>
        Effect.gen(function*() {
          const tenantId = yield* requireTenant
          const status = request.query["status"]
          return {
            approvals: yield* Effect.promise(() =>
              status === undefined
                ? dependencies.store.listApprovals(tenantId)
                : dependencies.store.listApprovals(tenantId, status))
          }
        }))
      .handle("approve", (request) =>
        Effect.gen(function*() {
          const tenantId = yield* requireTenant
          const id = request.params["id"]
          const by = yield* decidedBy
          const store = dependencies.store
          const approval = yield* Effect.promise(() => store.getApproval(tenantId, id))
          if (approval === undefined) {
            return yield* new ApiNotFound({ error: `Unknown approval ${id}` })
          }
          if (approval.status !== "pending") {
            return yield* new ApiBadRequest({ error: `Approval ${id} is already ${approval.status}` })
          }
          if (approval.expiresAt.getTime() <= Date.now()) {
            yield* Effect.promise(() =>
              store.settleApproval({
                tenantId,
                id,
                status: "expired",
                decidedBy: null,
                result: null,
                error: "expired before a decision was recorded"
              }))
            // Expiry is a decision, not an absence of one.
            return yield* new ApiBadRequest({ error: `Approval ${id} expired` })
          }

          const client = yield* Effect.promise(() => store.findClientById(tenantId, approval.clientId))
          const grants = yield* Effect.promise(() => store.listGrants(approval.clientId))
          const grant = grants.find((candidate) => candidate.id === approval.grantId)
          if (client === undefined || client.revokedAt !== null || grant === undefined) {
            yield* Effect.promise(() =>
              store.settleApproval({
                tenantId,
                id,
                status: "denied",
                decidedBy: by,
                result: null,
                error: "the client or grant was revoked while this call was frozen"
              }))
            return yield* new ApiBadRequest({ error: `Approval ${id} is no longer authorized` })
          }

          // The gateway performs the call. The caller is never handed the
          // ability to perform it, so approving confers no capability.
          const outcome = yield* Effect.promise(() =>
            executeAuthorized(
              {
                store,
                integrations: dependencies.integrations,
                retentionDays: dependencies.retentionDays
              },
              {
                status: "authorized",
                client,
                grant,
                connection: grant.connection,
                subject: grant.connection.owner === "user" ? grant.connection.subject : null
              },
              approval.arguments
            ))
          yield* Effect.promise(() =>
            store.settleApproval({
              tenantId,
              id,
              status: "approved",
              decidedBy: by,
              result: outcome.status === "succeeded" ? outcome.result : null,
              error: outcome.status === "failed" ? outcome.message : null
            }))
          const settled = yield* Effect.promise(() => store.getApproval(tenantId, id))
          if (settled === undefined) {
            return yield* new ApiNotFound({ error: `Unknown approval ${id}` })
          }
          if (outcome.status === "succeeded") {
            return {
              approval: settled,
              outcome: { status: "succeeded" as const, result: outcome.result }
            }
          }
          if (outcome.status === "failed") {
            return {
              approval: settled,
              outcome: { status: "failed" as const, message: outcome.message }
            }
          }
          // Unreachable through this path — settlement runs an authorized call,
          // which never freezes or denies — but the type stays honest.
          return yield* new ApiBadRequest({
            error: "Approval settled without a performed call"
          })
        }))
      .handle("deny", (request) =>
        Effect.gen(function*() {
          const tenantId = yield* requireTenant
          const id = request.params["id"]
          const by = yield* decidedBy
          const store = dependencies.store
          const approval = yield* Effect.promise(() => store.getApproval(tenantId, id))
          if (approval === undefined) {
            return yield* new ApiNotFound({ error: `Unknown approval ${id}` })
          }
          yield* Effect.promise(() =>
            store.settleApproval({
              tenantId,
              id,
              status: "denied",
              decidedBy: by,
              result: null,
              error: null
            }))
          const settled = yield* Effect.promise(() => store.getApproval(tenantId, id))
          if (settled === undefined) {
            return yield* new ApiNotFound({ error: `Unknown approval ${id}` })
          }
          return { approval: settled }
        }))
      .handle("refreshDrift", (request) =>
        Effect.gen(function*() {
          const tenantId = yield* requireTenant
          const slug = request.query["integration"]
          const slugs = slug === undefined
            ? (yield* Effect.promise(() => dependencies.integrations.catalog.list()))
              .map((entry) => entry.slug)
            : [slug]
          const reports: Array<Awaited<ReturnType<typeof refreshIntegrationSnapshot>>> = []
          for (const integration of slugs) {
            reports.push(yield* Effect.promise(() =>
              refreshIntegrationSnapshot(
                { store: dependencies.store, integrations: dependencies.integrations },
                integration,
                tenantId
              )))
          }
          return { reports }
        }))
      .handle("maintenance", () => Effect.promise(() => runMaintenance(dependencies.store)))
      .handle("audit", (request) =>
        Effect.gen(function*() {
          const tenantId = yield* requireTenant
          const query = request.query
          let sinceDate: Date | undefined
          if (query["since"] !== undefined) {
            sinceDate = new Date(query["since"])
            if (Number.isNaN(sinceDate.getTime())) {
              return yield* new ApiBadRequest({ error: `since is not a date: ${query["since"]}` })
            }
          }
          const filter = {
            ...whenPresentMap("clientId", query["clientId"], ClientId.make),
            ...whenPresentMap("alias", query["alias"], Alias.make),
            ...whenPresentMap(
              "tool",
              query["tool"] === undefined ? undefined : ToolName.make(query["tool"]),
              (tool) => tool
            ),
            ...whenPresentMap("outcome", query["outcome"], (o) => o),
            ...whenPresentMap("since", sinceDate, (d) => d)
          }
          const limit = positiveInt(query["limit"], 50)
          const offset = nonNegativeInt(query["offset"], 0)
          // The trail is permanent, so the count is what tells a reader whether
          // the window they asked for is the whole answer.
          return {
            records: yield* Effect.promise(() =>
              dependencies.store.listAudit(tenantId, { ...filter, limit, offset })),
            total: yield* Effect.promise(() => dependencies.store.countAudit(tenantId, filter)),
            limit,
            offset
          }
        })))

// --- auth -------------------------------------------------------------------

export const AuthLayer = (dependencies: {
  readonly store: GatewayStore
  readonly sessions: SessionDependencies
}) => {
  const ttlHours = dependencies.sessions.sessionTtlHours ?? defaultSessionTtlHours
  const secureCookies = dependencies.sessions.secureCookies
  const store = dependencies.store

  const issueSession = async (
    subjectId: SubjectId,
    tenantId: TenantId
  ): Promise<{ readonly token: string; readonly cookie: string }> => {
    const token = generateSessionToken()
    await store.createSession({
      tokenHash: token.hash,
      subjectId,
      tenantId,
      expiresAt: new Date(Date.now() + ttlHours * 60 * 60 * 1000)
    })
    return {
      token: token.secret,
      cookie: sessionCookieHeaderValue(token.secret, {
        maxAgeSeconds: Math.round(ttlHours * 60 * 60),
        secure: secureCookies
      })
    }
  }

  return HttpApiBuilder.group(GatewayApi, "auth", (handlers) =>
    handlers
      .handle("providers", () =>
        Effect.gen(function*() {
          const signupOpen = yield* Effect.promise(() => dependencies.sessions.signupOpen())
          const google = dependencies.sessions.google
          return {
            signupOpen,
            google: google === undefined
              ? ({ enabled: false } as const)
              : ({
                enabled: true,
                startUrl: "/v1/auth/google/start",
                callbackUrl: googleIdentityCallbackUrl(google)
              } as const)
          }
        }))
      .handle("cliStart", () =>
        Effect.gen(function*() {
          const google = dependencies.sessions.google
          if (google === undefined) {
            return yield* new ApiNotImplemented({
              error: "Browser sign-in is not configured on this gateway",
              code: "identity-provider-unavailable" as const
            })
          }
          const request = generateLoginHandoff()
          const expiresAt = new Date(Date.now() + 10 * 60 * 1000)
          yield* Effect.promise(() =>
            store.createLoginHandoff({ requestHash: request.hash, expiresAt }))
          const start = new URL("/v1/auth/google/start", googleIdentityCallbackUrl(google))
          start.searchParams.set("handoff", request.secret)
          return {
            requestId: request.secret,
            authorizationUrl: start.toString(),
            expiresAt,
            intervalMs: 1_000
          }
        }))
      .handle("cliPoll", (request) =>
        Effect.gen(function*() {
          const requestHash = hashLoginHandoff(request.params["id"])
          const handoff = yield* Effect.promise(() => store.getLoginHandoff(requestHash))
          if (handoff === undefined) {
            return yield* new HandoffUnknown({
              error: "Unknown login handoff",
              code: "login-handoff-unknown" as const
            })
          }
          if (handoff.expiresAt.getTime() <= Date.now()) {
            return yield* new HandoffExpired({
              error: "Login handoff expired",
              code: "login-handoff-expired" as const
            })
          }
          if (handoff.collectedAt !== null) {
            return yield* new HandoffCollected({
              error: "Login handoff was already collected",
              code: "login-handoff-collected" as const
            })
          }
          const subjectId = handoff.subjectId
          const tenantId = handoff.tenantId
          const email = handoff.email
          if (subjectId === null || tenantId === null || email === null) {
            return { status: "pending" as const, expiresAt: handoff.expiresAt }
          }
          if (!(yield* Effect.promise(() => store.collectLoginHandoff(requestHash)))) {
            return yield* new HandoffCollected({
              error: "Login handoff was collected concurrently",
              code: "login-handoff-collected" as const
            })
          }
          const session = yield* Effect.promise(() => issueSession(subjectId, tenantId))
          return {
            status: "authenticated" as const,
            token: session.token,
            email
          }
        }))
      .handle("googleStart", (request) =>
        Effect.gen(function*() {
          const google = dependencies.sessions.google
          if (google === undefined) {
            return page(501, {
              title: "Google sign-in unavailable",
              message: "This gateway has not configured Google sign-in."
            })
          }
          const handoffSecret = request.query["handoff"]
          const handoffHash = handoffSecret === undefined ? null : hashLoginHandoff(handoffSecret)
          if (handoffHash !== null) {
            const handoff = yield* Effect.promise(() => store.getLoginHandoff(handoffHash))
            if (handoff === undefined || handoff.expiresAt.getTime() <= Date.now() ||
              handoff.collectedAt !== null) {
              return page(410, {
                title: "Sign-in link expired",
                message: "Return to the terminal and run `ii login` again."
              })
            }
          }
          const state = generateLoginHandoff()
          const returnPath = safeReturnPath(request.query["returnTo"])
          yield* Effect.promise(() =>
            store.createIdentityOAuthState({
              stateHash: state.hash,
              provider: "google",
              handoffHash,
              returnPath,
              expiresAt: new Date(Date.now() + 10 * 60 * 1000)
            }))
          return HttpServerResponse.redirect(
            googleIdentityAuthorizationUrl(google, state.secret),
            { status: 302, headers: { "cache-control": "no-store" } }
          )
        }))
      .handle("googleCallback", (request) =>
        Effect.gen(function*() {
          const google = dependencies.sessions.google
          if (google === undefined) {
            return page(501, {
              title: "Google sign-in unavailable",
              message: "This gateway has not configured Google sign-in."
            })
          }
          const stateSecret = request.query["state"]
          const code = request.query["code"]
          if (stateSecret === undefined || code === undefined) {
            return page(400, {
              title: "Sign-in failed",
              message: "Google did not return a complete sign-in response."
            })
          }
          const state = yield* Effect.promise(() =>
            store.consumeIdentityOAuthState(hashLoginHandoff(stateSecret)))
          if (state === undefined) {
            return page(400, {
              title: "Sign-in expired",
              message: "This sign-in could not be verified. Start again."
            })
          }
          const outcome = yield* Effect.promise(() =>
            completeGoogleSignIn(dependencies, google, code, state, issueSession))
          if (outcome._tag === "page") {
            return page(outcome.status, { title: outcome.title, message: outcome.message })
          }
          if (outcome.handoffHash !== null) {
            return page(200, {
              title: "Signed in",
              message: "The terminal is authenticated. You can close this window and return to ii."
            }, { "set-cookie": outcome.cookie })
          }
          return HttpServerResponse.redirect(outcome.returnPath ?? "/", {
            status: 302,
            headers: { "set-cookie": outcome.cookie, "cache-control": "no-store" }
          })
        }))
      .handle("signup", (request) =>
        Effect.gen(function*() {
          if (!(yield* Effect.promise(() => dependencies.sessions.signupOpen()))) {
            return yield* new SignupClosed({
              error: "Signup is closed on this gateway",
              code: "signup-closed" as const
            })
          }
          const body = request.payload
          if ((yield* Effect.promise(() =>
            store.findLoginByEmail(body.email))) !== undefined) {
            // Stated as taken rather than attempted-and-failed: this is a
            // signup form, not a login oracle.
            return yield* new ApiBadRequest({ error: `An account for ${body.email} already exists` })
          }
          // Open signup mints a fresh partition per account; joining an
          // existing tenant is an operator action, not a self-serve one.
          const tenant = yield* Effect.promise(() =>
            store.createTenant({
              id: newTenantId(),
              name: body.tenantName ?? body.email.split("@")[0] ?? body.email
            }))
          const subject = yield* Effect.promise(() =>
            store.createSubject({ id: newSubjectId(), tenantId: tenant.id }))
          const passwordHash = yield* Effect.promise(() => hashPassword(body.password))
          yield* Effect.promise(() =>
            store.createLogin({
              subjectId: subject.id,
              tenantId: tenant.id,
              email: body.email,
              passwordHash
            }))
          // Signing up is signing in: the first session starts immediately.
          const session = yield* Effect.promise(() => issueSession(subject.id, tenant.id))
          return json(201, {
            tenant: { id: tenant.id, name: tenant.name },
            subjectId: subject.id,
            email: body.email
          }, { "set-cookie": session.cookie })
        }))
      .handle("login", (request) =>
        Effect.gen(function*() {
          const checked = yield* Effect.promise(() =>
            verifyLoginPassword(store, request.payload.email, request.payload.password))
          if (!checked.accepted) {
            return yield* new InvalidCredentials({
              error: "Email or password is not correct",
              code: "invalid-credentials" as const
            })
          }
          const session = yield* Effect.promise(() =>
            issueSession(checked.login.subjectId, checked.login.tenantId))
          return json(200, {
            email: checked.login.email,
            subjectId: checked.login.subjectId
          }, { "set-cookie": session.cookie })
        }))
      .handle("logout", () =>
        Effect.gen(function*() {
          const caller = yield* Identity
          // Revoking beats merely forgetting: a stolen cookie stays valid until
          // its row is gone, so logout deletes the session server-side too.
          if (caller.kind === "session") {
            yield* Effect.promise(() => store.revokeSession(caller.tokenHash))
          }
          return json(200, { loggedOut: true }, {
            "set-cookie": clearedSessionCookieHeaderValue({ secure: secureCookies })
          })
        }))
      .handle("whoami", () =>
        Effect.gen(function*() {
          const caller = yield* Identity
          if (caller.kind === "session") {
            const login = yield* Effect.promise(() => store.findLoginBySubject(caller.subjectId))
            const identities = yield* Effect.promise(() =>
              store.listExternalIdentities(caller.subjectId))
            return {
              authenticated: true as const,
              kind: "session" as const,
              email: caller.email,
              tenantId: caller.tenantId,
              subjectId: caller.subjectId,
              hasPassword: login?.passwordHash !== null && login?.passwordHash !== undefined,
              identityProviders: identities.map((identity) => identity.provider)
            }
          }
          if (caller.kind === "client") {
            return {
              authenticated: true as const,
              kind: "client" as const,
              clientId: caller.client.id,
              tenantId: caller.client.tenantId,
              capabilities: caller.client.capabilities
            }
          }
          if (caller.kind === "local") {
            return {
              authenticated: true as const,
              kind: "local" as const,
              clientId: caller.client.id,
              tenantId: caller.client.tenantId
            }
          }
          return { authenticated: false as const }
        }))
      .handle("changeEmail", (request) =>
        Effect.gen(function*() {
          const caller = yield* Identity
          if (caller.kind !== "session") {
            return yield* new Forbidden({
              code: "not-permitted",
              error: "Only a signed-in human may change account details"
            })
          }
          const body = request.payload
          const login = yield* Effect.promise(() => store.findLoginByEmail(caller.email))
          const passwordHash = login === undefined ? null : login.passwordHash
          const verified = login !== undefined && passwordHash !== null &&
            (yield* Effect.promise(() => verifyPassword(body.password, passwordHash)))
          if (!verified || login === undefined) {
            return yield* new InvalidCredentials({
              error: "Email or password is not correct",
              code: "invalid-credentials" as const
            })
          }
          // Same email is a no-op rather than an argument with the schema.
          if (body.email !== login.email &&
            (yield* Effect.promise(() =>
              store.findLoginByEmail(body.email))) !== undefined) {
            return yield* new ApiBadRequest({ error: `An account for ${body.email} already exists` })
          }
          yield* Effect.promise(() =>
            store.changeLoginEmail(caller.subjectId, body.email))
          // The identity travels in the session row's join; sessions survive an
          // email change, so no re-login is forced.
          return { email: body.email }
        }))
      .handle("changePassword", (request) =>
        Effect.gen(function*() {
          const caller = yield* Identity
          if (caller.kind !== "session") {
            return yield* new Forbidden({
              code: "not-permitted",
              error: "Only a signed-in human may change account details"
            })
          }
          const body = request.payload
          const login = yield* Effect.promise(() => store.findLoginByEmail(caller.email))
          const currentPassword = body.currentPassword
          const passwordHash = login === undefined ? null : login.passwordHash
          const accepted = login !== undefined && (
            passwordHash === null
              ? currentPassword === undefined
              : currentPassword !== undefined &&
                (yield* Effect.promise(() =>
                  verifyPassword(currentPassword, passwordHash)))
          )
          if (!accepted || login === undefined) {
            return yield* new InvalidCredentials({
              error: "Email or password is not correct",
              code: "invalid-credentials" as const
            })
          }
          const newPasswordHash = yield* Effect.promise(() => hashPassword(body.newPassword))
          yield* Effect.promise(() =>
            store.changeLoginPassword(caller.subjectId, newPasswordHash))
          // A password change is a statement that the old one was compromised-
          // adjacent at best; every other device re-authenticates.
          const revoked = yield* Effect.promise(() =>
            store.revokeSubjectSessions(caller.subjectId, caller.tokenHash))
          return { updated: true as const, revokedSessions: revoked }
        }))
      .handle("deleteAccount", (request) =>
        Effect.gen(function*() {
          const caller = yield* Identity
          if (caller.kind !== "session") {
            return yield* new Forbidden({
              code: "not-permitted",
              error: "Only a signed-in human may change account details"
            })
          }
          const body = request.payload
          const login = yield* Effect.promise(() => store.findLoginByEmail(caller.email))
          const passwordHash = login?.passwordHash ?? null
          if (login !== undefined && passwordHash === null) {
            return yield* new PasswordRequired({
              error: "Set a password before deleting an OAuth-only account",
              code: "password-required" as const
            })
          }
          const presented = body.password
          const accepted = login !== undefined && passwordHash !== null &&
            presented !== undefined &&
            (yield* Effect.promise(() => verifyPassword(presented, passwordHash)))
          if (!accepted) {
            return yield* new InvalidCredentials({
              error: "Email or password is not correct",
              code: "invalid-credentials" as const
            })
          }
          // The subject goes first — its cascade takes the login and sessions —
          // and the workspace follows only when nobody is left inside it. A
          // shared tenant survives its member; a solo signup takes its clients,
          // keys, grants, approvals, and audit rows down with it.
          yield* Effect.promise(() => store.deleteSubject(caller.subjectId))
          if ((yield* Effect.promise(() => store.countSubjects(caller.tenantId))) === 0) {
            yield* Effect.promise(() => store.deleteTenant(caller.tenantId))
          }
          // Vendor connections live in the host's own storage keyed by address,
          // outside this store; they are not reclaimed here.
          return json(200, { deleted: true }, {
            "set-cookie": clearedSessionCookieHeaderValue({ secure: secureCookies })
          })
        })))
}

const defaultSessionTtlHours = 24 * 30

type GoogleCallbackOutcome = {
  readonly _tag: "page"
  readonly status: number
  readonly title: string
  readonly message: string
} | {
  readonly _tag: "signedIn"
  readonly handoffHash: string | null
  readonly returnPath: string | null
  readonly cookie: string
}

const completeGoogleSignIn = async (
  dependencies: {
    readonly store: GatewayStore
    readonly sessions: SessionDependencies
  },
  google: GoogleIdentityOAuth,
  code: string,
  state: { readonly handoffHash: string | null; readonly returnPath: string | null },
  issueSession: (subjectId: SubjectId, tenantId: TenantId) => Promise<{ readonly token: string; readonly cookie: string }>
): Promise<GoogleCallbackOutcome> => {
  const store = dependencies.store
  const identity = await resolveGoogleIdentity(google, code)
  const existingIdentity = await store.findExternalIdentity("google", identity.providerSubject)
  let login = existingIdentity === undefined
    ? await store.findLoginByEmail(identity.email)
    : await store.findLoginBySubject(existingIdentity.subjectId)

  if (login === undefined) {
    if (!(await dependencies.sessions.signupOpen())) {
      return {
        _tag: "page",
        status: 403,
        title: "Account not found",
        message: "This gateway does not allow new accounts. Ask an operator to invite or create yours."
      }
    }
    const tenant = await store.createTenant({
      id: newTenantId(),
      name: identity.email.split("@")[0] ?? identity.email
    })
    const subject = await store.createSubject({ id: newSubjectId(), tenantId: tenant.id })
    login = await store.createLogin({
      subjectId: subject.id,
      tenantId: tenant.id,
      email: identity.email,
      passwordHash: null
    })
  }

  await store.createExternalIdentity({
    provider: "google",
    providerSubject: identity.providerSubject,
    subjectId: login.subjectId,
    tenantId: login.tenantId,
    email: identity.email
  })
  const handoffHash = state.handoffHash
  if (handoffHash !== null) {
    const completed = await store.completeLoginHandoff({
      requestHash: LoginHandoffHash.make(handoffHash),
      subjectId: login.subjectId,
      tenantId: login.tenantId,
      email: login.email
    })
    if (!completed) {
      return {
        _tag: "page",
        status: 410,
        title: "Terminal sign-in expired",
        message: "Return to the terminal and run `ii login` again."
      }
    }
  }
  const session = await issueSession(login.subjectId, login.tenantId)
  return {
    _tag: "signedIn",
    handoffHash: state.handoffHash,
    returnPath: state.returnPath,
    cookie: session.cookie
  }
}
