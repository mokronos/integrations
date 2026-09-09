import {
  whenPresent,
  whenPresentMap
} from "@integrations/contracts"
import {
  AuthTemplateSlug,
  Integrations,
  listIntegrationOverviews,
  provisionIntegration,
  searchIntegrations,
  validateIntegrationNode as validateNode
} from "@integrations/integrations"
import type { IntegrationServices } from "@integrations/integrations"
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
} from "@integrations/contracts"
import { boundToolAddress } from "@integrations/gateway-core"
import {
  forgetConnection,
  reconcileDefaults
} from "@integrations/gateway-core"
import { oauthBrowserPage } from "@integrations/gateway-core"
import type { GatewayStore } from "@integrations/gateway-core"
import { GatewayStoreService } from "@integrations/gateway-core"
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

const requireSlug = (value: string): Effect.Effect<IntegrationSlug, ApiNotFound> =>
  Option.match(Schema.decodeUnknownOption(IntegrationSlug)(value), {
    onNone: () => Effect.fail(new ApiNotFound({ error: `Unknown integration ${value}` })),
    onSome: Effect.succeed
  })

const page = (
  status: number,
  content: { readonly title: string; readonly message: string }
): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.text(oauthBrowserPage(content), {
    status,
    contentType: "text/html; charset=utf-8"
  })

const normalizeName = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, "")

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

const validateGatewayNode = (
  dependencies: {
    readonly store: GatewayStore
    readonly integrations: Integrations["Service"]
  },
  clientId: ClientId | undefined,
  source: { readonly alias: string; readonly tool: string },
  live: boolean
) =>
  Effect.gen(function*() {
    const findings: Array<{ severity: string; check: string; message: string }> = []
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
          message: `${source.alias}.${source.tool} is not authorized for this key`
        })
      } else {
        findings.push({
          severity: "info",
          check: "authorization",
          message: `${source.alias}.${source.tool} resolves to ${accessTool.connection.integration}/${accessTool.connection.name}`
        })
        const address = boundToolAddress(accessTool.connection, ToolName.make(source.tool))
        const tools = yield* capture(dependencies.integrations.listTools())
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

export const ProvisioningLayer = HttpApiBuilder.group(GatewayApi, "provisioning", (handlers) =>
  Effect.gen(function*() {
    const store = yield* GatewayStoreService
    const integrations = yield* Integrations
    const integrationServices = yield* Effect.context<IntegrationServices>()
    const oauth = yield* OAuthFlowSessions
    const config = yield* GatewayConfig
    return handlers
      .handle("listIntegrations", () =>
        Effect.gen(function*() {
          const integrations = yield* capture(
            listIntegrationOverviews().pipe(Effect.provide(integrationServices))
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
        }).pipe(Effect.provide(integrationServices))))
      .handle("renameIntegration", (request) =>
        Effect.gen(function*() {
          const slug = yield* requireSlug(request.params["slug"])
          const found = yield* capture(integrations.findIntegration(slug))
          if (Option.isNone(found)) {
            return yield* new ApiNotFound({ error: `Unknown integration ${slug}` })
          }
          yield* capture(integrations.renameIntegration(slug, request.payload.name))
          const renamed = yield* capture(integrations.findIntegration(slug))
          if (Option.isNone(renamed)) {
            return yield* new ApiNotFound({ error: `Unknown integration ${slug}` })
          }
          return renamed.value
        }))
      .handle("integrationTools", (request) =>
        Effect.gen(function*() {
          const slug = yield* requireSlug(request.params["slug"])
          return { tools: yield* capture(integrations.toolSummaries({ integration: slug })) }
        }))
      .handle("describeTool", (request) =>
        Effect.gen(function*() {
          const slug = yield* requireSlug(request.params["slug"])
          return yield* asApiFailure(integrations.describeTool({
            integration: slug,
            name: request.params["tool"],
            ...whenPresentMap("connection", request.query["connection"], (c) => ConnectionName.make(c))
          }))
        }))
      .handle("registrySearch", (request) =>
        asApiFailure(searchIntegrations(
          {
            q: request.query["q"],
            limit: request.query["limit"],
            ...whenPresentMap("kind", request.query["kind"], (k) => k)
          },
          whenPresent("registryUrl", config.registryUrl)
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
              { store: store, integrations },
              clientId,
              source,
              body.live ?? true
            )
          }
          return yield* capture(
            validateNode(body.node, { live: body.live ?? true })
              .pipe(Effect.provide(integrationServices))
          )
        }))
      .handle("listConnections", () =>
        Effect.map(capture(integrations.listConnections()), (connections) => ({ connections })))
      .handle("connect", (request) =>
        Effect.gen(function*() {
          const tenantId = yield* requireTenant
          const body = request.payload
          const slug = yield* requireSlug(body.integration)
          const found = yield* capture(integrations.findIntegration(slug))
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
          const connection = yield* asApiFailure(integrations.createConnection({
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
          yield* reconcileDefaults({ store, integrations, tenantId }).pipe(capture)
          return {
            connection,
            tools: yield* capture(integrations.toolSummaries({
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
          const found = yield* capture(integrations.findIntegration(slug))
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
          const found = yield* capture(integrations.findIntegration(slug))
          if (Option.isNone(found)) {
            return yield* new ApiNotFound({ error: `Unknown integration ${slug}` })
          }
          const connections = yield* capture(integrations.listConnections())
          const owned = connections.filter((connection) => connection.integration === slug)
          yield* Effect.forEach(owned, (connection) =>
            forgetConnection({
              store,
              tenantId,
              integration: slug,
              connection: connection.name
            }).pipe(capture))
          yield* capture(integrations.removeIntegration(slug))
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
          const connections = yield* capture(integrations.listConnections())
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
          yield* capture(integrations.removeConnection({
            owner: match.owner,
            integration: match.integration,
            name: match.name
          }))
          yield* forgetConnection({
            store,
            tenantId,
            integration,
            connection: match.name
          }).pipe(capture)
          return { removed: true as const, integration, connection: match.name }
        }))
  }))
