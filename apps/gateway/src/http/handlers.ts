import { Clock, Effect, Predicate, Schema } from "effect"
import { HttpEffect, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import type { IntegrationsApi } from "@mokronos/integration-host"
import { IntegrationsApiService, searchIntegrations } from "@mokronos/integration-host"
import {
  gatewayProtocolVersion,
  NonNegativeInt,
  PositiveInt,
  whenPresent,
  whenPresentMap
} from "@mokronos/contracts"
import type { JsonObject } from "@mokronos/contracts"
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
import type { GoogleIdentityOAuth } from "../identity-oauth.ts"
import {
  googleIdentityAuthorizationUrl,
  googleIdentityCallbackUrl,
  resolveGoogleIdentity
} from "../identity-oauth.ts"
import { oauthBrowserPage } from "../oauth.ts"
import type { GatewayStore } from "../store.ts"
import { GatewayStoreService } from "../store.ts"
import type { WebAssets } from "../web-assets.ts"
import { gatewayVersion } from "../version.ts"
import {
  clearSessionCookie,
  decidedBy,
  Forbidden,
  Identity,
  requireClient,
  requireSecret,
  requireTenant,
  setSessionCookie
} from "./authority.ts"
import {
  ControlPlaneAssets,
  GatewayConfig,
  OAuthFlowSessions,
  SessionPolicy
} from "./services.ts"
import type { SignInPolicy } from "./services.ts"
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

/** Handlers for every endpoint in {@link GatewayApi}.
 *
 *  Each group layer asks the context for what it needs and bridges to the
 *  existing async domain code; those bridges shrink as the domain and store
 *  become Effects themselves. */

const json = (status: number, body: JsonObject): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.jsonUnsafe(body, { status })

/** A call that leaves this process — the caller's own URL, the public registry,
 *  a vendor API, an identity provider.
 *
 *  Failure out there is routine and almost always the caller's to act on: an
 *  unreachable host, a document that is not an OpenAPI spec, a provider saying
 *  no. Wrapping it in `Effect.promise` made every one of those an undeclared
 *  defect and a 500 that named nothing. This declares it instead, and says what
 *  the far end said. */
const reachOut = <A>(what: string, call: () => Promise<A>): Effect.Effect<A, ApiBadRequest> =>
  Effect.tryPromise({
    try: call,
    catch: (cause) =>
      new ApiBadRequest({
        error: `${what}: ${Predicate.isError(cause) ? cause.message : String(cause)}`
      })
  })

/** Sets a response header without giving up the endpoint's declared schema:
 *  the handler still returns its typed value and the API still encodes it. */
const withResponseHeader = (name: string, value: string) =>
  HttpEffect.appendPreResponseHandler((_request, response) =>
    Effect.succeed(HttpServerResponse.setHeader(response, name, value)))

/** An HTML page for the OAuth browser flow — one of the few responses here
 *  that really is low-level HTTP rather than a typed endpoint's success value.
 *  It no longer carries headers: a cookie set alongside a page goes through
 *  {@link setSessionCookie} like every other cookie does. */
const page = (
  status: number,
  content: { readonly title: string; readonly message: string }
): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.text(oauthBrowserPage(content), {
    status,
    contentType: "text/html; charset=utf-8"
  })

/** Compares connection names the way a human means them. The host stores a
 *  normalised name (`docs-demo` becomes `docsDemo`), and rather than reproduce
 *  that transformation — which belongs to the host and may change — this
 *  compares the parts a separator convention cannot alter. */
const normalizeName = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, "")

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
      Effect.gen(function*() {
        yield* withResponseHeader("cache-control", "no-store")
        return { ok: true as const, protocolVersion: gatewayProtocolVersion, gatewayVersion }
      })))

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
export const FallbackLayer = HttpApiBuilder.group(GatewayApi, "fallback", (handlers) =>
  Effect.gen(function*() {
    const { assets } = yield* ControlPlaneAssets
    return handlers
      .handle("unmatchedGet", () => unmatched(assets))
      // Only GET can mean "a page"; a POST to an unknown path is a mistake in
      // the caller, not a request for the control plane.
      .handle("unmatchedPost", () => unmatched(undefined))
      .handle("unmatchedDelete", () => unmatched(undefined))
  }))


// --- delegated --------------------------------------------------------------

export const DelegatedLayer = HttpApiBuilder.group(GatewayApi, "delegated", (handlers) =>
  Effect.gen(function*() {
    const store = yield* GatewayStoreService
    const integrationsApi = yield* IntegrationsApiService
    const config = yield* GatewayConfig
    return handlers
      .handle("listTools", (request) =>
        Effect.gen(function*() {
          const client = yield* requireClient
          return {
            tools: yield* Effect.promise(() =>
              listGrantedTools(store, client.id, {
                schemas: request.query["schemas"],
                integrations: integrationsApi
              }))
          }
        }))
      .handle("execute", (request) =>
        Effect.gen(function*() {
          const secret = yield* requireSecret
          return yield* Effect.promise(() =>
            invokeThroughGateway(
              {
                store,
                integrations: integrationsApi,
                argumentRetentionDays: config.retentionDays,
                approvalUrlOf: (approvalId) => {
                  const origin = config.dashboardUrl?.()
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
            store.getApproval(client.tenantId, id))
          // Scoped to the caller: one client must not read another's frozen call.
          if (approval === undefined || approval.clientId !== client.id) {
            return yield* new ApiNotFound({ error: `Unknown approval ${id}` })
          }
          return approval
        }))
  }))

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

export const ProvisioningLayer = HttpApiBuilder.group(GatewayApi, "provisioning", (handlers) =>
  Effect.gen(function*() {
    const store = yield* GatewayStoreService
    const integrationsApi = yield* IntegrationsApiService
    const oauth = yield* OAuthFlowSessions
    const config = yield* GatewayConfig
    return handlers
      .handle("listIntegrations", () =>
        Effect.gen(function*() {
          const integrations = yield* Effect.promise(() =>
            integrationsApi.listIntegrationOverviews())
          return {
            integrations,
            ...whenPresentMap("oauthCallbackUrl", config.oauthCallbackUrl?.(), (url) => url)
          }
        }))
      .handle("discover", (request) =>
        reachOut(`Could not read an integration from ${request.payload.url}`, () =>
          integrationsApi.provisioning.provision(
            request.payload.url,
            request.payload.connection === undefined
              ? {}
              : { connection: request.payload.connection }
          )))
      .handle("integrationTools", (request) =>
        Effect.map(
          Effect.promise(() =>
            integrationsApi.tools.summaries({ integration: request.params["slug"] })),
          (tools) => ({ tools })
        ))
      .handle("describeTool", (request) =>
        Effect.promise(() =>
          integrationsApi.tools.describe({
            integration: request.params["slug"],
            name: request.params["tool"],
            ...whenPresentMap("connection", request.query["connection"], (c) => c)
          })))
      .handle("registrySearch", (request) =>
        reachOut("The integration registry could not be searched", () =>
          searchIntegrations(
            {
              q: request.query["q"],
              limit: request.query["limit"],
              ...whenPresentMap("kind", request.query["kind"], (k) => k)
            },
            whenPresent("registryUrl", config.registryUrl)
          )))
      .handle("invokeTool", (request) =>
        // Administrative, and deliberately not grant-checked: a client that may
        // mutate grants could grant itself this tool in one extra call, so a
        // check here would be friction rather than a control. The delegated
        // surface has no address form at all. See docs/adr/0002.
        reachOut(`${request.payload.address} failed`, () =>
          integrationsApi.tools.execute(
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
            return yield* validateGatewayNode(
              { store: store, integrations: integrationsApi },
              clientId,
              source,
              body.live ?? true
            )
          }
          return yield* Effect.promise(() =>
            integrationsApi.validateIntegrationNode(body.node, { live: body.live ?? true }))
        }))
      .handle("listConnections", () =>
        Effect.map(
          Effect.promise(() => integrationsApi.connections.list()),
          (connections) => ({ connections })
        ))
      .handle("connect", (request) =>
        Effect.gen(function*() {
          const body = request.payload
          const integration = yield* Effect.promise(() =>
            integrationsApi.catalog.find(body.integration))
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
            integrationsApi.connections.create({
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
              integrationsApi.tools.summaries({
                integration: integration.slug,
                connection: connection.name
              }))
          }
        }))
      .handle("startOAuth", (request) =>
        Effect.gen(function*() {
          const body = request.payload
          const integration = yield* Effect.promise(() =>
            integrationsApi.catalog.find(body.integration))
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
          return yield* reachOut(`${body.integration} could not start an OAuth flow`, () =>
            oauth.start({
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
          const session = yield* Effect.promise(() => oauth.get(request.params["id"]))
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
          // A browser is reading this, so a failure out at the provider becomes
          // a page rather than the JSON refusal every other surface gets.
          const completed = yield* Effect.catch(
            reachOut("Authorization could not be completed", () =>
              oauth.completeByState(state, {
                code,
                ...whenPresentMap("callbackDomain", request.query["domain"] ?? request.query["site"], (d) => d)
              })),
            (refusal) =>
              Effect.succeed(page(502, {
                title: "Authorization failed",
                message: refusal.error
              }))
          )
          if (HttpServerResponse.isHttpServerResponse(completed)) return completed
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
            integrationsApi.connections.list())
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
            integrationsApi.connections.remove({ integration, name: match.name }))
          return { removed: true as const, integration, connection: match.name }
      }))
  }))

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
) =>
  Effect.gen(function*() {
    const findings: Array<{ severity: string; check: string; message: string }> = []
    // The same rule `Alias` already carries, asked rather than restated: a
    // second copy of the pattern is a second thing to keep in step.
    const aliasIsWellFormed = Schema.is(Alias)(source.alias)
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
  })

// --- administrative ---------------------------------------------------------

export const AdministrativeLayer = HttpApiBuilder.group(GatewayApi, "administrative", (handlers) =>
  Effect.gen(function*() {
    const store = yield* GatewayStoreService
    const integrationsApi = yield* IntegrationsApiService
    const config = yield* GatewayConfig
    return handlers
      .handle("overview", () =>
        Effect.gen(function*() {
          const tenantId = yield* requireTenant
          const [counts, connections, recentActivity] = yield* Effect.all([
            Effect.promise(() => store.overviewCounts(tenantId)),
            Effect.promise(() => integrationsApi.connections.list()),
            Effect.promise(() => store.listAudit(tenantId, {
              limit: PositiveInt.make(5),
              offset: NonNegativeInt.make(0)
            }))
          ])
          return { ...counts, connections: connections.length, recentActivity }
        }))
      .handle("listClients", () =>
        Effect.gen(function*() {
          const tenantId = yield* requireTenant
          return {
            clients: yield* Effect.promise(() => store.listClients(tenantId))
          }
        }))
      .handle("createClient", (request) =>
        Effect.gen(function*() {
          const tenantId = yield* requireTenant
          const body = request.payload
          if ((yield* Effect.promise(() =>
            store.findClientByName(tenantId, body.name))) !== undefined) {
            return yield* new ApiBadRequest({ error: `A client named ${body.name} already exists` })
          }
          // Clients are created inside the caller's partition. There is no way
          // to provision into another tenant over this surface, by design.
          return yield* Effect.promise(() =>
            store.createClient({
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
            store.findClientById(tenantId, clientId))
          if (existing === undefined) {
            return yield* new ApiNotFound({ error: `Unknown client ${clientId}` })
          }
          if (existing.revokedAt !== null) {
            return yield* new ApiBadRequest({ error: `Client ${clientId} is revoked` })
          }
          return yield* Effect.promise(() =>
            store.updateClientSettings({
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
            store.findClientById(tenantId, clientId))) === undefined) {
            return yield* new ApiNotFound({ error: `Unknown client ${clientId}` })
          }
          const key = generateApiKey()
          yield* Effect.promise(() =>
            store.addApiKey({ id: key.id, clientId, hash: key.hash }))
          // The only time the plaintext exists outside the caller's hands.
          return { id: key.id, clientId, secret: key.secret }
        }))
      .handle("listKeys", (request) =>
        Effect.gen(function*() {
          const tenantId = yield* requireTenant
          const clientId = request.params["id"]
          if ((yield* Effect.promise(() =>
            store.findClientById(tenantId, clientId))) === undefined) {
            return yield* new ApiNotFound({ error: `Unknown client ${clientId}` })
          }
          // Hashes stay behind the gateway. What an operator needs is which keys
          // exist, when each was last used, and which are still live.
          const keys = yield* Effect.promise(() => store.listApiKeys(clientId))
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
          yield* Effect.promise(() => store.revokeApiKey(keyId))
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
            store.findClientById(tenantId, clientId))) === undefined) {
            return yield* new ApiNotFound({ error: `Unknown client ${clientId}` })
          }
          // The same listing `/v1/tools` gives a key about itself, asked about
          // someone else. Generating bindings for the client you are
          // provisioning should not require holding its key.
          return {
            tools: yield* Effect.promise(() =>
              listGrantedTools(store, clientId, {
                schemas: request.query["schemas"],
                integrations: integrationsApi
              }))
          }
        }))
      .handle("revokeClient", (request) =>
        Effect.gen(function*() {
          const tenantId = yield* requireTenant
          const clientId = request.params["id"]
          if ((yield* Effect.promise(() =>
            store.findClientById(tenantId, clientId))) === undefined) {
            return yield* new ApiNotFound({ error: `Unknown client ${clientId}` })
          }
          yield* Effect.promise(() => store.revokeClient(tenantId, clientId))
          // Revoking a client is done because something is wrong, so its frozen
          // actions must not stay armed. Revoking a single key does not do this.
          const cancelled = yield* Effect.promise(() =>
            store.cancelApprovalsForClient(clientId))
          return { revoked: true as const, cancelledApprovals: cancelled }
        }))
      .handle("listGrants", (request) =>
        Effect.map(
          Effect.promise(() => store.listGrants(request.query["clientId"])),
          (grants) => ({ grants })
        ))
      .handle("createGrant", (request) =>
        Effect.gen(function*() {
          const tenantId = yield* requireTenant
          const body = request.payload
          const clientId = body.clientId
          if ((yield* Effect.promise(() =>
            store.findClientById(tenantId, clientId))) === undefined) {
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
            integrationsApi.tools.summaries({ integration: body.connection.integration }))
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
            store.createGrant({
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
            store.revokeGrant(tenantId, request.params["id"]))
          return { revoked: true as const }
        }))
      .handle("listApprovals", (request) =>
        Effect.gen(function*() {
          const tenantId = yield* requireTenant
          const status = request.query["status"]
          return {
            approvals: yield* Effect.promise(() =>
              status === undefined
                ? store.listApprovals(tenantId)
                : store.listApprovals(tenantId, status))
          }
        }))
      .handle("approve", (request) =>
        Effect.gen(function*() {
          const tenantId = yield* requireTenant
          const id = request.params["id"]
          const by = yield* decidedBy
          const approval = yield* Effect.promise(() => store.getApproval(tenantId, id))
          if (approval === undefined) {
            return yield* new ApiNotFound({ error: `Unknown approval ${id}` })
          }
          if (approval.status !== "pending") {
            return yield* new ApiBadRequest({ error: `Approval ${id} is already ${approval.status}` })
          }
          const now = yield* Clock.currentTimeMillis
          if (approval.expiresAt.getTime() <= now) {
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
                integrations: integrationsApi,
                retentionDays: config.retentionDays
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
            ? (yield* Effect.promise(() => integrationsApi.catalog.list()))
              .map((entry) => entry.slug)
            : [slug]
          const reports: Array<Awaited<ReturnType<typeof refreshIntegrationSnapshot>>> = []
          for (const integration of slugs) {
            reports.push(yield* Effect.promise(() =>
              refreshIntegrationSnapshot(
                { store: store, integrations: integrationsApi },
                integration,
                tenantId
              )))
          }
          return { reports }
        }))
      .handle("maintenance", () => Effect.promise(() => runMaintenance(store)))
      .handle("audit", (request) =>
        Effect.gen(function*() {
          const tenantId = yield* requireTenant
          const query = request.query
          const filter = {
            ...whenPresentMap("clientId", query["clientId"], ClientId.make),
            ...whenPresentMap("alias", query["alias"], Alias.make),
            ...whenPresentMap(
              "tool",
              query["tool"] === undefined ? undefined : ToolName.make(query["tool"]),
              (tool) => tool
            ),
            ...whenPresentMap("outcome", query["outcome"], (o) => o),
            ...whenPresentMap("since", query["since"], (since) => since)
          }
          const limit = query["limit"]
          const offset = query["offset"]
          // The trail is permanent, so the count is what tells a reader whether
          // the window they asked for is the whole answer.
          return {
            records: yield* Effect.promise(() =>
              store.listAudit(tenantId, { ...filter, limit, offset })),
            total: yield* Effect.promise(() => store.countAudit(tenantId, filter)),
            limit,
            offset
          }
        }))
  }))

// --- auth -------------------------------------------------------------------

export const AuthLayer = HttpApiBuilder.group(GatewayApi, "auth", (handlers) =>
  Effect.gen(function*() {
    const store = yield* GatewayStoreService
    const sessions = yield* SessionPolicy
    const ttlHours = sessions.sessionTtlHours ?? defaultSessionTtlHours
    const secureCookies = sessions.secureCookies

    const issueSession = (subjectId: SubjectId, tenantId: TenantId) =>
      Effect.gen(function*() {
        const token = generateSessionToken()
        const expiresAt = new Date((yield* Clock.currentTimeMillis) + ttlHours * 60 * 60 * 1000)
        yield* Effect.promise(() =>
          store.createSession({ tokenHash: token.hash, subjectId, tenantId, expiresAt }))
        return { token: token.secret }
      })

    /** The cookie every sign-in path ends with, whatever shape its response takes. */
    const startSession = (token: string) =>
      setSessionCookie(token, {
        maxAgeSeconds: Math.round(ttlHours * 60 * 60),
        secure: secureCookies
      })

    return handlers
      .handle("providers", () =>
        Effect.gen(function*() {
          const signupOpen = yield* Effect.promise(() => sessions.signupOpen())
          const google = sessions.google
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
          const google = sessions.google
          if (google === undefined) {
            return yield* new ApiNotImplemented({
              error: "Browser sign-in is not configured on this gateway",
              code: "identity-provider-unavailable" as const
            })
          }
          const request = generateLoginHandoff()
          const expiresAt = new Date((yield* Clock.currentTimeMillis) + handoffTtlMs)
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
          if (handoff.expiresAt.getTime() <= (yield* Clock.currentTimeMillis)) {
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
          const session = yield* issueSession(subjectId, tenantId)
          return {
            status: "authenticated" as const,
            token: session.token,
            email
          }
        }))
      .handle("googleStart", (request) =>
        Effect.gen(function*() {
          const google = sessions.google
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
            const now = yield* Clock.currentTimeMillis
            if (handoff === undefined || handoff.expiresAt.getTime() <= now ||
              handoff.collectedAt !== null) {
              return page(410, {
                title: "Sign-in link expired",
                message: "Return to the terminal and run `ii login` again."
              })
            }
          }
          const state = generateLoginHandoff()
          const returnPath = safeReturnPath(request.query["returnTo"])
          const stateExpiresAtMs = (yield* Clock.currentTimeMillis) + handoffTtlMs
          yield* Effect.promise(() =>
            store.createIdentityOAuthState({
              stateHash: state.hash,
              provider: "google",
              handoffHash,
              returnPath,
              expiresAt: new Date(stateExpiresAtMs)
            }))
          return HttpServerResponse.redirect(
            googleIdentityAuthorizationUrl(google, state.secret),
            { status: 302, headers: { "cache-control": "no-store" } }
          )
        }))
      .handle("googleCallback", (request) =>
        Effect.gen(function*() {
          const google = sessions.google
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
          const outcome = yield* completeGoogleSignIn(
            { store, sessions },
            google,
            code,
            state,
            issueSession
          )
          if (outcome._tag === "page") {
            return page(outcome.status, { title: outcome.title, message: outcome.message })
          }
          yield* startSession(outcome.token)
          if (outcome.handoffHash !== null) {
            return page(200, {
              title: "Signed in",
              message: "The terminal is authenticated. You can close this window and return to ii."
            })
          }
          return HttpServerResponse.redirect(outcome.returnPath ?? "/", {
            status: 302,
            headers: { "cache-control": "no-store" }
          })
        }))
      .handle("signup", (request) =>
        Effect.gen(function*() {
          if (!(yield* Effect.promise(() => sessions.signupOpen()))) {
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
          const session = yield* issueSession(subject.id, tenant.id)
          yield* startSession(session.token)
          return {
            tenant: { id: tenant.id, name: tenant.name },
            subjectId: subject.id,
            email: body.email
          }
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
          const session = yield* issueSession(checked.login.subjectId, checked.login.tenantId)
          yield* startSession(session.token)
          return {
            email: checked.login.email,
            subjectId: checked.login.subjectId
          }
        }))
      .handle("logout", () =>
        Effect.gen(function*() {
          const caller = yield* Identity
          // Revoking beats merely forgetting: a stolen cookie stays valid until
          // its row is gone, so logout deletes the session server-side too.
          if (caller.kind === "session") {
            yield* Effect.promise(() => store.revokeSession(caller.tokenHash))
          }
          yield* clearSessionCookie({ secure: secureCookies })
          return { loggedOut: true }
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
          yield* clearSessionCookie({ secure: secureCookies })
          return { deleted: true }
        }))
  }))

const defaultSessionTtlHours = 24 * 30

/** How long a browser sign-in link and its OAuth state stay usable. Short on
 *  purpose: the human is standing there. */
const handoffTtlMs = 10 * 60 * 1000

type GoogleCallbackOutcome = {
  readonly _tag: "page"
  readonly status: number
  readonly title: string
  readonly message: string
} | {
  readonly _tag: "signedIn"
  readonly handoffHash: string | null
  readonly returnPath: string | null
  readonly token: string
}

const completeGoogleSignIn = (
  dependencies: {
    readonly store: GatewayStore
    readonly sessions: SignInPolicy
  },
  google: GoogleIdentityOAuth,
  code: string,
  state: { readonly handoffHash: string | null; readonly returnPath: string | null },
  issueSession: (
    subjectId: SubjectId,
    tenantId: TenantId
  ) => Effect.Effect<{ readonly token: string }>
): Effect.Effect<GoogleCallbackOutcome> =>
  Effect.gen(function*() {
    const store = dependencies.store
    // Google is the far end here. It being unreachable is not this gateway
    // breaking, and the human staring at the browser deserves to be told which.
    const identity = yield* Effect.result(
      Effect.tryPromise(() => resolveGoogleIdentity(google, code))
    )
    if (identity._tag === "Failure") {
      return {
        _tag: "page",
        status: 502,
        title: "Sign-in failed",
        message: "Google could not be reached to confirm this sign-in. Try again."
      } as const
    }
    const existingIdentity = yield* Effect.promise(() =>
      store.findExternalIdentity("google", identity.success.providerSubject))
    let login = yield* Effect.promise(() =>
      existingIdentity === undefined
        ? store.findLoginByEmail(identity.success.email)
        : store.findLoginBySubject(existingIdentity.subjectId))

    if (login === undefined) {
      if (!(yield* Effect.promise(() => dependencies.sessions.signupOpen()))) {
        return {
          _tag: "page",
          status: 403,
          title: "Account not found",
          message: "This gateway does not allow new accounts. Ask an operator to invite or create yours."
        } as const
      }
      const tenant = yield* Effect.promise(() =>
        store.createTenant({
          id: newTenantId(),
          name: identity.success.email.split("@")[0] ?? identity.success.email
        }))
      const subject = yield* Effect.promise(() =>
        store.createSubject({ id: newSubjectId(), tenantId: tenant.id }))
      login = yield* Effect.promise(() =>
        store.createLogin({
          subjectId: subject.id,
          tenantId: tenant.id,
          email: identity.success.email,
          passwordHash: null
        }))
    }

    yield* Effect.promise(() =>
      store.createExternalIdentity({
        provider: "google",
        providerSubject: identity.success.providerSubject,
        subjectId: login.subjectId,
        tenantId: login.tenantId,
        email: identity.success.email
      }))
    const handoffHash = state.handoffHash
    if (handoffHash !== null) {
      const completed = yield* Effect.promise(() =>
        store.completeLoginHandoff({
          requestHash: LoginHandoffHash.make(handoffHash),
          subjectId: login.subjectId,
          tenantId: login.tenantId,
          email: login.email
        }))
      if (!completed) {
        return {
          _tag: "page",
          status: 410,
          title: "Terminal sign-in expired",
          message: "Return to the terminal and run `ii login` again."
        } as const
      }
    }
    const session = yield* issueSession(login.subjectId, login.tenantId)
    return {
      _tag: "signedIn",
      handoffHash: state.handoffHash,
      returnPath: state.returnPath,
      token: session.token
    } as const
  })
