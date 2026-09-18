import { whenPresent, whenPresentMap } from "@mokronos/integrations-contracts"
import {
  Integrations,
  listIntegrationOverviews,
  provisionIntegration,
  searchIntegrations
} from "@mokronos/integrations-host"
import type { IntegrationServices } from "@mokronos/integrations-host"
import { Effect, Option } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ConnectionName } from "@mokronos/integrations-contracts"
import { connectionRefOf, forgetConnection, oauthBrowserPage, GatewayStoreService } from "@mokronos/integrations-gateway-core"
import { ApiBadRequest, ApiNotFound, GatewayApi } from "../api.ts"
import { Identity, requireTenant } from "../authority.ts"
import { GatewayConfig } from "../services.ts"
import { OAuthFlowSessions } from "@mokronos/integrations-gateway-core"
import { capture } from "../observability.ts"
import { asApiFailure } from "./host-failure.ts"
import {
  connectWithCredentials,
  OperationRefused,
  removeConnectionByName,
  requireSlug as decodeSlug,
  startOAuthConnection,
  validateReference
} from "../operations.ts"

const refusalAsApiFailure = <A, E, R>(effect: Effect.Effect<A, E | OperationRefused, R>) =>
  asApiFailure(Effect.catchIf(
    effect,
    (failure): failure is OperationRefused => failure instanceof OperationRefused,
    (refusal) =>
      Effect.fail(refusal.status === "not-found"
        ? new ApiNotFound({ error: refusal.message })
        : new ApiBadRequest({ error: refusal.message }))
  ))

const requireSlug = (value: string) =>
  Effect.mapError(decodeSlug(value), (refusal) => new ApiNotFound({ error: refusal.message }))

const refusalAsNotFound = <A, E, R>(effect: Effect.Effect<A, E | OperationRefused, R>) =>
  Effect.catchIf(
    effect,
    (failure): failure is OperationRefused => failure instanceof OperationRefused,
    (refusal) => Effect.fail(new ApiNotFound({ error: refusal.message }))
  )

const page = (
  status: number,
  content: { readonly title: string; readonly message: string }
): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.text(oauthBrowserPage(content), {
    status,
    contentType: "text/html; charset=utf-8"
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
          const caller = yield* Identity
          const clientId = caller.kind === "client" || caller.kind === "local" ? caller.client.id : undefined
          return yield* validateReference(clientId, request.payload.node, request.payload.live ?? true)
        }))
      .handle("listConnections", () =>
        Effect.map(capture(integrations.listConnections()), (connections) => ({ connections })))
      .handle("connect", (request) =>
        Effect.gen(function*() {
          const tenantId = yield* requireTenant
          return yield* refusalAsApiFailure(connectWithCredentials(tenantId, request.payload))
        }))
      .handle("startOAuth", (request) =>
        Effect.gen(function*() {
          const tenantId = yield* requireTenant
          return yield* refusalAsApiFailure(startOAuthConnection(tenantId, request.payload))
        }))
      .handle("oauthSession", (request) =>
        Effect.gen(function*() {
          const session = yield* capture(oauth.get(request.params["id"]))
          if (session === undefined) {
            return yield* new ApiNotFound({ error: "Unknown or expired OAuth session" })
          }
          return session
        }))
      .handle("provideOAuthClient", (request) =>
        Effect.gen(function*() {
          const secret = request.payload.clientSecret?.trim()
          const resumed = yield* asApiFailure(oauth.provideClient(request.params["id"], {
            clientId: request.payload.clientId.trim(),
            ...whenPresent("clientSecret", secret === undefined || secret.length === 0 ? undefined : secret)
          }))
          if (resumed === undefined) {
            return yield* new ApiNotFound({
              error: "Unknown OAuth session, or it is no longer waiting for an OAuth client"
            })
          }
          return resumed
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
              connection: connectionRefOf(connection.owner, slug, connection.name)
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
          return yield* refusalAsNotFound(
            removeConnectionByName(tenantId, request.params["integration"], request.params["name"])
          )
        }))
  }))
