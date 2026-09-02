import {
  whenPresent,
  whenPresentMap
} from "@mokronos/contracts"
import type { IntegrationsApi } from "@mokronos/integrations"
import { IntegrationsApiService, searchIntegrations } from "@mokronos/integrations"
import { Effect, Predicate, Schema } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import {
  Alias,
  ClientId,
  aliasForConnection,
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
import { GatewayStoreError, GatewayStoreService } from "@mokronos/gateway-core"
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

const orDieStorage = <A, E, R>(effect: Effect.Effect<A, E | GatewayStoreError, R>) =>
  effect.pipe(Effect.catchTag("GatewayStoreError", Effect.die))

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
      const accessProfile = clientId === undefined
        ? undefined
        : yield* orDieStorage(dependencies.store.findAccessProfileForClient(clientId))
      const approvalPolicy = clientId === undefined
        ? undefined
        : yield* orDieStorage(dependencies.store.findApprovalPolicyForClient(clientId))
      const accessTools = accessProfile === undefined
        ? []
        : yield* orDieStorage(dependencies.store.listAccessProfileTools(accessProfile.id))
      const approvalTools = approvalPolicy === undefined
        ? []
        : yield* orDieStorage(dependencies.store.listApprovalPolicyTools(approvalPolicy.id))
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
        const tools = yield* Effect.promise(() => dependencies.integrations.tools.list())
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
        // Administrative and deliberately not delegated-policy checked: a client
        // with administration authority can change policy in a separate call, so a
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
          // A connection belongs to a tenant, not to whoever asked for it, so
          // this needs the partition and nothing more. Demanding a client key
          // here refused the signed-in human that the route's `provisioning`
          // access had already admitted — the dashboard could not connect
          // anything.
          const tenantId = yield* requireTenant
          const body = request.payload
          const integration = yield* Effect.promise(() =>
            integrationsApi.catalog.find(body.integration))
          if (integration === undefined) {
            return yield* new ApiNotFound({ error: `Unknown integration ${body.integration}` })
          }
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
          yield* reconcileDefaults({ store, integrations: integrationsApi, tenantId }).pipe(orDieStorage)
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
          const tenantId = yield* requireTenant
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
          const session = yield* oauth.get(request.params["id"]).pipe(Effect.orDie)
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
          const slug = request.params["slug"]
          const found = yield* Effect.promise(() => integrationsApi.catalog.find(slug))
          if (found === undefined) {
            return yield* new ApiNotFound({ error: `Unknown integration ${slug}` })
          }
          const connections = yield* Effect.promise(() =>
            integrationsApi.connections.list())
          const owned = connections.filter((connection) => connection.integration === slug)
          // The policy rules naming each connection are dropped one at a time,
          // before the catalog forgets which connections there were.
          yield* Effect.forEach(owned, (connection) =>
            forgetConnection({
              store,
              tenantId,
              integration: slug,
              connection: connection.name
            }).pipe(orDieStorage))
          yield* Effect.promise(() => integrationsApi.catalog.remove(slug))
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
          // Rules that named the deleted credential go with it, for every
          // policy in the tenant the caller belongs to.
          yield* forgetConnection({
            store,
            tenantId,
            integration,
            connection: match.name
          }).pipe(orDieStorage)
          return { removed: true as const, integration, connection: match.name }
        }))
  }))
