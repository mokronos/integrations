import { Cause, Context, Effect, Layer, Option, Result, Schema } from "effect"
import { FileSystem, Path } from "effect"
import {
  Etag,
  HttpClient,
  HttpEffect,
  HttpMiddleware,
  HttpPlatform,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse
} from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { HttpApiSchemaError } from "effect/unstable/httpapi/HttpApiError"
import { GatewayApi } from "./api.ts"
import {
  Authority,
  authorityLayer,
  CurrentRequestContext
} from "./authority.ts"
import type { RateLimits } from "./authority.ts"
import {
  AdministrativeLayer,
  AuthLayer,
  DelegatedLayer,
  FallbackLayer,
  OAuthLayer,
  ProvisioningLayer,
  SystemLayer
} from "./handlers.ts"
import { ControlPlaneAssets, GatewayConfig, SessionPolicy } from "./services.ts"
import { ErrorCapture, traceIdFor } from "./observability.ts"
import { GatewayFailure } from "./identity.ts"
import type { ErrorSink } from "./observability.ts"
import type { GatewaySettings, SignInPolicy } from "./services.ts"
import { defaultMaxUploadBytes, NonNegativeIntFromString, whenPresent } from "@integragents/contracts"
import type { IntegrationServices } from "@integragents/host"
import { GatewayEvents, GatewayStoreService, OAuthFlowSessions } from "@integragents/gateway-core"
import type { EventBus } from "@integragents/gateway-core"
import type { GatewayCoreServices } from "@integragents/gateway-core"
import { webCryptoLayer } from "@integragents/contracts"
import type { GatewayStore } from "@integragents/gateway-core"
import type { OAuthSessions } from "@integragents/gateway-core"
import type { WebAssets } from "../web-assets.ts"
import { createMcpGatewayHandler } from "./mcp.ts"
import { createMcpOAuthHandler, mcpOAuthPaths } from "./mcp-oauth.ts"

export interface GatewayRequestContext {
  readonly localSecret?: string
  readonly remoteAddress?: string
}

export const gatewayServicesContext = (input: {
  readonly store: GatewayStore
  readonly integrationServices: Context.Context<IntegrationServices>
  readonly oauth: OAuthSessions
  readonly events: EventBus
}): Context.Context<GatewayCoreServices> =>
  input.integrationServices.pipe(
    Context.add(GatewayStoreService, input.store),
    Context.add(OAuthFlowSessions, input.oauth),
    Context.add(GatewayEvents, input.events)
  )

export interface GatewayHandlerOptions extends GatewaySettings {
  readonly store: GatewayStore
  readonly integrationServices: Context.Context<IntegrationServices>
  readonly httpClient: Layer.Layer<HttpClient.HttpClient>
  readonly oauth: OAuthSessions
  /** Where the store's writes are announced; `/v1/events` streams them. */
  readonly events: EventBus
  /** Who is calling. Defaults to the gateway's own keys, sessions, and local credential. */
  readonly authority?: Layer.Layer<Authority, never, GatewayStoreService>
  readonly sessions?: SignInPolicy
  readonly rateLimits?: RateLimits
  readonly maxBodyBytes?: number
  readonly maxUploadBytes?: number
  readonly webAssets?: WebAssets
  /** The tracer, loggers, and log level every surface of this gateway reports through. */
  readonly telemetry?: Layer.Layer<never>
  readonly errorCapture?: ErrorSink
}

const bodyLimitLayer = (limits: { readonly request: number; readonly upload: number }) =>
  HttpRouter.use((router) =>
    router.addGlobalMiddleware((httpEffect) =>
      Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) => {
        const declared = Schema.decodeUnknownOption(NonNegativeIntFromString)(
          request.headers["content-length"]
        )
        // Blob uploads are the one route whose whole purpose is a large body.
        const maxBytes = new URL(request.url, "http://localhost").pathname === "/v1/blobs"
          ? limits.upload
          : limits.request
        return Option.getOrElse(declared, () => 0) > maxBytes
          ? Effect.succeed(HttpServerResponse.jsonUnsafe(
            { error: `Request body exceeds ${maxBytes} bytes` },
            { status: 413 }
          ))
          : httpEffect
      })))

const encodeGatewayFailure = Schema.encodeSync(GatewayFailure)

const failureLayer = () =>
  HttpRouter.use((router) =>
    router.addGlobalMiddleware((httpEffect) =>
      Effect.catchCauseIf(
        httpEffect,
        (cause) => Cause.hasDies(cause) || Cause.hasFails(cause),
        (cause) => {
          const defect = Cause.findDefect(cause)
          const schemaError = Result.isSuccess(defect) && HttpApiSchemaError.is(defect.success)
            ? defect.success
            : undefined
          if (schemaError !== undefined) {
            return Effect.succeed(HttpServerResponse.jsonUnsafe(
              {
                error: schemaError.cause instanceof Error
                  ? schemaError.cause.message
                  : "Request body did not match the expected shape"
              },
              { status: 400 }
            ))
          }
          return Effect.map(
            traceIdFor(cause),
            (traceId) =>
              HttpServerResponse.jsonUnsafe(
                encodeGatewayFailure(new GatewayFailure({
                  message: "The gateway could not complete this request",
                  traceId
                })),
                { status: 500 }
              )
          )
        }
      )))

export const defaultMaxBodyBytes = 1024 * 1024

const settingsOf = (options: GatewayHandlerOptions): GatewaySettings => ({
  retentionDays: options.retentionDays,
  ...whenPresent("dashboardUrl", options.dashboardUrl),
  ...whenPresent("oauthCallbackUrl", options.oauthCallbackUrl),
  ...whenPresent("mcpUrl", options.mcpUrl),
  ...whenPresent("registryUrl", options.registryUrl)
})

export const gatewayAppLayer = (options: GatewayHandlerOptions) => {
  const errorCapture = options.errorCapture === undefined
    ? ErrorCapture.logging
    : Layer.succeed(ErrorCapture, options.errorCapture)

  const services = Layer.succeedContext(gatewayServicesContext(options))
  const dependencies = Layer.mergeAll(
    errorCapture,
    services,
    Layer.succeed(GatewayConfig, settingsOf(options)),
    options.sessions === undefined
      ? SessionPolicy.closed
      : Layer.succeed(SessionPolicy, options.sessions),
    ControlPlaneAssets.layerOf(options.webAssets)
  )

  const groups = Layer.mergeAll(
    SystemLayer,
    FallbackLayer,
    DelegatedLayer,
    ProvisioningLayer,
    AdministrativeLayer,
    AuthLayer,
    OAuthLayer
  ).pipe(Layer.provide(dependencies))

  const platform = Layer.mergeAll(
    FileSystem.layerNoop({}),
    HttpPlatform.layer.pipe(Layer.provide(FileSystem.layerNoop({}))),
    HttpRouter.layer,
    Etag.layerWeak,
    Path.layer
  )
  const base = failureLayer().pipe(
    Layer.provideMerge(bodyLimitLayer({
      request: options.maxBodyBytes ?? defaultMaxBodyBytes,
      upload: options.maxUploadBytes ?? defaultMaxUploadBytes
    })),
    Layer.provideMerge(platform),
    Layer.provideMerge(errorCapture)
  )
  const authority = (options.authority ?? authorityLayer(whenPresent("rateLimits", options.rateLimits))).pipe(
    Layer.provide(services)
  )
  return base.pipe(
    Layer.provideMerge(groups),
    Layer.provideMerge(authority)
  )
}



/** Every path the gateway answers, as URL patterns; the rest belongs to the dashboard. */
export const gatewayRoutes: ReadonlyArray<string> = [
  "/v1/*",
  "/mcp",
  mcpOAuthPaths.protectedResource,
  `${mcpOAuthPaths.protectedResource}/*`,
  mcpOAuthPaths.authorizationServer,
  mcpOAuthPaths.register,
  mcpOAuthPaths.authorize,
  mcpOAuthPaths.token
]

export interface GatewayHandle {
  handle(request: Request, context?: GatewayRequestContext): Promise<Response>
  dispose(): Promise<void>
}

export const createGatewayHandler = (options: GatewayHandlerOptions): GatewayHandle => {
  const telemetry = options.telemetry ?? Layer.empty
  const app = HttpApiBuilder.layer(GatewayApi).pipe(
    Layer.provideMerge(gatewayAppLayer(options)),
    HttpRouter.provideRequest(Layer.mergeAll(
      options.httpClient,
      webCryptoLayer,
      Layer.succeedContext(gatewayServicesContext(options)),
      Layer.succeed(GatewayConfig, settingsOf(options)),
      options.errorCapture === undefined ? ErrorCapture.logging : Layer.succeed(ErrorCapture, options.errorCapture)
    ))
  )
  const web = HttpEffect.toWebHandlerLayerWith(
    app.pipe(Layer.provideMerge(Layer.merge(
      telemetry,
      HttpMiddleware.layerTracerDisabledForUrls(["/v1/health", "/v1/metadata", "/v1/events"])
    ))), {
    toHandler: (context) =>
      Effect.succeed(
        Context.getUnsafe(HttpRouter.HttpRouter)(context).asHttpEffect()
      )
  })
  const contextFor = (requestContext: GatewayRequestContext | undefined) =>
    requestContext === undefined
      ? undefined
      : Context.makeUnsafe(new Map([[String(CurrentRequestContext.key), requestContext]]))
  const oauth = createMcpOAuthHandler({
    store: options.store,
    settings: settingsOf(options),
    httpClient: options.httpClient,
    telemetry,
    ...whenPresent("registrationLimitPerMinute", options.rateLimits?.addressPerMinute)
  })
  const mcp = createMcpGatewayHandler({
    store: options.store,
    services: gatewayServicesContext(options),
    settings: settingsOf(options),
    httpClient: options.httpClient,
    telemetry,
    ...whenPresent("errorCapture", options.errorCapture),
    oauth
  })
  return {
    handle: async (request, requestContext) => {
      const oauthResponse = await oauth.handle(request, requestContext)
      if (oauthResponse !== undefined) return oauthResponse
      return new URL(request.url).pathname === "/mcp"
        ? mcp.handle(request)
        : web.handler(request, contextFor(requestContext) ?? Context.empty())
    },
    dispose: async () => {
      await mcp.dispose()
      await oauth.dispose()
      await web.dispose()
    }
  }
}
