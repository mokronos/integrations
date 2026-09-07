import {
  whenPresent,
  whenPresentMap
} from "@mokronos/contracts"
import {
  AuthTemplateSlug,
  IntegrationHost,
  listIntegrationOverviews,
  provisionIntegration,
  searchIntegrations,
  validateIntegrationNode as validateNode
} from "@mokronos/integrations"
import type { HostServices } from "@mokronos/integrations"
import { Effect, Option, Schema } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import {
  Alias,
  ClientId,
  aliasForConnection,
  ConnectionName,
  IntegrationSlug,
  sameConnectionRef,
  ToolName
} from "@mokronos/gateway-core"
import { boundToolAddress } from "@mokronos/gateway-core"
import {
  forgetConnection,
  reconcileDefaults
} from "@mokronos/gateway-core"
import { oauthBrowserPage } from "@mokronos/gateway-core"
import type { GatewayStore } from "@mokronos/gateway-core"
import { GatewayStoreService } from "@mokronos/gateway-core"
import {
  ApiBadRequest,
  ApiNotFound,
  GatewayApi
} from "../api.ts"
import { Identity, requireTenant } from "../authority.ts"
import {
  GatewayConfig,
  OAuthFlowSessions
} from "../services.ts"
import { capture } from "../observability.ts"
import { asApiFailure } from "./host-failure.ts"

/** A slug off the wire, as the host addresses them.
 *
 *  Anything that is not slug-shaped names no integration, so it is refused here
 *  with the same 404 an unknown-but-well-formed slug gets. The facade used to
 *  swallow the decode failure and answer `undefined`, which produced the same
 *  response by accident rather than on purpose. */
const requireSlug = (value: string): Effect.Effect<IntegrationSlug, ApiNotFound> =>
  Option.match(Schema.decodeUnknownOption(IntegrationSlug)(value), {
    onNone: () => Effect.fail(new ApiNotFound({ error: `Unknown integration ${value}` })),
    onSome: Effect.succeed
  })

/** An HTML page for the OAuth browser flow — one of the few responses here
 *  that really is low-level HTTP rather than a typed endpoint's success value.
 *  It no longer carries headers; cookies are set through the auth helpers. */
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

// --- system -----------------------------------------------------------------

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

const GatewayNodeSource = Schema.Struct({
  source: Schema.Struct({
    kind: Schema.Literal("gateway"),
    alias: Schema.String,
    tool: Schema.String
  })
})

/** Answers the question a workflow author is actually asking: will this step
 *  resolve when it runs, as *this* caller? An alias is not a name in the
 *  catalog; it is a client-local binding, so structural validity and
 *  reachability are separate findings. */
const validateGatewayNode = (
  dependencies: {
    readonly store: GatewayStore
    readonly host: IntegrationHost["Service"]
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
      const accessProfile = clientId === undefined
        ? undefined
        : yield* capture(dependencies.store.findAccessProfileForClient(clientId))
      const approvalPolicy = clientId === undefined
        ? undefined
        : yield* capture(dependencies.store.findApprovalPolicyForClient(clientId))
      const accessTools = accessProfile === undefined
        ? []
        : yield* capture(dependencies.store.listAccessProfileTools(accessProfile.id))
      const approvalTools = approvalPolicy === undefined
        ? []
        : yield* capture(dependencies.store.listApprovalPolicyTools(approvalPolicy.id))
      const accessTool = accessTools.find((tool) => tool.tool === source.tool && aliasForConnection(tool.connection) === source.alias)
      const approvalTool = accessTool === undefined ? undefined : approvalTools.find((tool) =>
        tool.tool === source.tool && sameConnectionRef(tool.connection, accessTool.connection))
      if (clientId === undefined) {
        findings.push({
          severity: "error",
          check: "authorization",
          message: "Gateway aliases are client-specific; validate this node with i and its client key"
        })
      } else if (accessTool === undefined || approvalTool === undefined) {
        findings.push({
          severity: "error",
          check: "authorization",
          // Naming the alias but not what else it exposes: a validation report
          // is not a place to enumerate a caller's other capabilities.
          message: `${source.alias}.${source.tool} is not authorized for this key`
        })
      } else {
        findings.push({
          severity: "info",
          check: "authorization",
          message: `${source.alias}.${source.tool} resolves to ${accessTool.connection.integration}/${accessTool.connection.name}`
        })
        const address = boundToolAddress(accessTool.connection, ToolName.make(source.tool))
        const tools = yield* capture(dependencies.host.listTools())
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

// --- administrative ---------------------------------------------------------

export const ProvisioningLayer = HttpApiBuilder.group(GatewayApi, "provisioning", (handlers) =>
  Effect.gen(function*() {
    const store = yield* GatewayStoreService
    const host = yield* IntegrationHost
    // The host's services, captured once while the group builds. The three
    // composites below reach past `IntegrationHost` — reading an unknown
    // endpoint needs the MCP client and the spec cache — and a handler's `R`
    // channel is a per-request requirement, so they are provided here rather
    // than becoming something every route has to satisfy.
    const hostServices = yield* Effect.context<HostServices>()
    const oauth = yield* OAuthFlowSessions
    const config = yield* GatewayConfig
    return handlers
      .handle("listIntegrations", () =>
        Effect.gen(function*() {
          const integrations = yield* capture(
            listIntegrationOverviews().pipe(Effect.provide(hostServices))
          )
          return {
            integrations,
            ...whenPresentMap("oauthCallbackUrl", config.oauthCallbackUrl?.(), (url) => url)
          }
        }))
      .handle("discover", (request) =>
        asApiFailure(provisionIntegration(request.payload.url, {
          ...whenPresent("connection", request.payload.connection),
          ...whenPresent("slug", request.payload.slug),
          ...whenPresent("name", request.payload.name)
        }).pipe(Effect.provide(hostServices))))
      .handle("renameIntegration", (request) =>
        Effect.gen(function*() {
          const slug = yield* requireSlug(request.params["slug"])
          const found = yield* capture(host.findIntegration(slug))
          if (Option.isNone(found)) {
            return yield* new ApiNotFound({ error: `Unknown integration ${slug}` })
          }
          // Only the display name changes, so nothing addressed elsewhere moves
          // and there is nothing to reconcile.
          yield* capture(host.renameIntegration(slug, request.payload.name))
          const renamed = yield* capture(host.findIntegration(slug))
          if (Option.isNone(renamed)) {
            return yield* new ApiNotFound({ error: `Unknown integration ${slug}` })
          }
          return renamed.value
        }))
      .handle("integrationTools", (request) =>
        Effect.gen(function*() {
          const slug = yield* requireSlug(request.params["slug"])
          return { tools: yield* capture(host.toolSummaries({ integration: slug })) }
        }))
      .handle("describeTool", (request) =>
        Effect.gen(function*() {
          const slug = yield* requireSlug(request.params["slug"])
          return yield* asApiFailure(host.describeTool({
            integration: slug,
            name: request.params["tool"],
            ...whenPresentMap("connection", request.query["connection"], (c) => ConnectionName.make(c))
          }))
        }))
      .handle("registrySearch", (request) =>
        // The registry is somebody else's server, so a failure here is the
        // caller's to see: `InvocationError` already says whether the query was
        // malformed or the registry would not answer.
        asApiFailure(searchIntegrations(
          {
            q: request.query["q"],
            limit: request.query["limit"],
            ...whenPresentMap("kind", request.query["kind"], (k) => k)
          },
          whenPresent("registryUrl", config.registryUrl)
        )))
      .handle("invokeTool", (request) =>
        // Administrative and deliberately not delegated-policy checked: a client
        // with administration authority can change policy in a separate call, so a
        // check here would be friction rather than a control. The delegated
        // surface has no address form at all. See docs/adr/0002.
        asApiFailure(host.execute(
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
              { store: store, host },
              clientId,
              source,
              body.live ?? true
            )
          }
          return yield* capture(
            validateNode(body.node, { live: body.live ?? true })
              .pipe(Effect.provide(hostServices))
          )
        }))
      .handle("listConnections", () =>
        Effect.map(capture(host.listConnections()), (connections) => ({ connections })))
      .handle("connect", (request) =>
        Effect.gen(function*() {
          // A connection belongs to a tenant, not to whoever asked for it, so
          // this needs the partition and nothing more. Demanding a client key
          // here refused the signed-in human that the route's `provisioning`
          // access had already admitted — the dashboard could not connect
          // anything.
          const tenantId = yield* requireTenant
          const body = request.payload
          const slug = yield* requireSlug(body.integration)
          const found = yield* capture(host.findIntegration(slug))
          if (Option.isNone(found)) {
            return yield* new ApiNotFound({ error: `Unknown integration ${body.integration}` })
          }
          const integration = found.value
          const method = selectAuthMethod(integration.authMethods, body.template)
          if (method === undefined) {
            return yield* new ApiBadRequest({
              error: `No auth template named "${body.template}" for ${integration.slug}. Available: ${integration.authMethods.map((candidate) => candidate.template).join(", ")
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
          const connection = yield* asApiFailure(host.createConnection({
            owner: "org",
            integration: slug,
            name: ConnectionName.make(body.connection ?? "default"),
            template: AuthTemplateSlug.make(method.template),
            ...(names.length === 0
              ? { value: "" }
              : names.length === 1 && values["token"] !== undefined
                ? { value: values["token"] }
                : { values })
          }))
          yield* reconcileDefaults({ store, integrations: { host }, tenantId }).pipe(capture)
          return {
            connection,
            tools: yield* capture(host.toolSummaries({
              integration: slug,
              connection: connection.name
            }))
          }
        }))
      .handle("startOAuth", (request) =>
        Effect.gen(function*() {
          const tenantId = yield* requireTenant
          const body = request.payload
          const slug = yield* requireSlug(body.integration)
          const found = yield* capture(host.findIntegration(slug))
          if (Option.isNone(found)) {
            return yield* new ApiNotFound({ error: `Unknown integration ${body.integration}` })
          }
          const integration = found.value
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
          return yield* oauth.start({
            integration: integration.slug,
            connection: body.connection ?? "default",
            authMethod: method,
            bindingTenant: tenantId,
            ...whenPresentMap("clientId", body.clientId, (id) => id),
            ...whenPresentMap("clientSecret", body.clientSecret, (secret) => secret),
            ...whenPresentMap(
              "timeoutMs",
              body.timeoutSeconds === undefined
                ? undefined
                : Math.max(1, body.timeoutSeconds) * 1000,
              (ms) => ms
            )
          }).pipe(Effect.mapError((failure) => new ApiBadRequest({
            error: `${body.integration} could not start an OAuth flow: ${failure.cause instanceof Error ? failure.cause.message : String(failure.cause)
              }`
          })))
        }))
      .handle("oauthSession", (request) =>
        Effect.gen(function*() {
          const session = yield* capture(oauth.get(request.params["id"]))
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
            oauth.completeByState(state, {
              code,
              ...whenPresentMap("callbackDomain", request.query["domain"] ?? request.query["site"], (d) => d)
            }),
            (refusal) =>
              Effect.succeed(page(502, {
                title: "Authorization failed",
                message: refusal.cause instanceof Error
                  ? refusal.cause.message
                  : "Authorization could not be completed"
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
      .handle("removeIntegration", (request) =>
        Effect.gen(function*() {
          const tenantId = yield* requireTenant
          const slug = yield* requireSlug(request.params["slug"])
          const found = yield* capture(host.findIntegration(slug))
          if (Option.isNone(found)) {
            return yield* new ApiNotFound({ error: `Unknown integration ${slug}` })
          }
          const connections = yield* capture(host.listConnections())
          const owned = connections.filter((connection) => connection.integration === slug)
          // The policy rules naming each connection are dropped one at a time,
          // before the catalog forgets which connections there were.
          yield* Effect.forEach(owned, (connection) =>
            forgetConnection({
              store,
              tenantId,
              integration: slug,
              connection: connection.name
            }).pipe(capture))
          yield* capture(host.removeIntegration(slug))
          return {
            removed: true as const,
            integration: slug,
            connections: owned.map((connection) => connection.name)
          }
        }))
      .handle("removeConnection", (request) =>
        Effect.gen(function*() {
          const tenantId = yield* requireTenant
          const integration = request.params["integration"]
          const requested = request.params["name"]
          // Connection names are normalised on the way in (`docs-demo` and
          // `docs_demo` are the same connection), so removing one by the name
          // you typed has to resolve through the same normalisation. Otherwise
          // a connection you just made cannot be deleted by the name you made
          // it with.
          const connections = yield* capture(host.listConnections())
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
          // `match` came out of the host's own listing, and `Connection` now
          // carries its brands, so there is nothing left to re-validate.
          yield* capture(host.removeConnection({
            owner: match.owner,
            integration: match.integration,
            name: match.name
          }))
          // Rules that named the deleted credential go with it, for every
          // policy in the tenant the caller belongs to.
          yield* forgetConnection({
            store,
            tenantId,
            integration,
            connection: match.name
          }).pipe(capture)
          return { removed: true as const, integration, connection: match.name }
        }))
  }))
