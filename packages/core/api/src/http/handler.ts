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
  CurrentRequestContext
} from "./authority.ts"
import {
  AdministrativeLayer,
  AuthLayer,
  DelegatedLayer,
  FallbackLayer,
  ProvisioningLayer,
  SystemLayer
} from "./handlers.ts"
import {
  ControlPlaneAssets,
  GatewayConfig,
  OAuthFlowSessions,
  SessionPolicy
} from "./services.ts"
import { ErrorCapture, traceIdFor } from "./observability.ts"
import type { ErrorSink } from "./observability.ts"
import type { GatewaySettings, SignInPolicy } from "./services.ts"
import { NonNegativeIntFromString, whenPresent, whenPresentMap } from "@mokronos/contracts"
import type { HostServices } from "@mokronos/integrations"
import { GatewayStoreService } from "@mokronos/gateway-core"
import type { GatewayStore } from "@mokronos/gateway-core"
import type { OAuthSessions } from "@mokronos/gateway-core"
import type { WebAssets } from "../web-assets.ts"
import type { RateLimiter } from "@mokronos/gateway-core"
import { createMcpGatewayHandler } from "./mcp.ts"

export interface GatewayRequestContext {
  readonly localSecret?: string
  readonly remoteAddress?: string
}

export interface GatewayHandlerOptions extends GatewaySettings {
  readonly store: GatewayStore
  readonly hostServices: Context.Context<HostServices>
  readonly httpClient: Layer.Layer<HttpClient.HttpClient>
  readonly oauth: OAuthSessions
  readonly sessions?: SignInPolicy
  readonly addressRateLimiter?: RateLimiter
  readonly rateLimiter?: RateLimiter
  readonly maxBodyBytes?: number
  readonly webAssets?: WebAssets
  readonly observabilityLayer?: Layer.Layer<never>
  readonly errorCapture?: ErrorSink
}

const bodyLimitLayer = (maxBytes: number) =>
  HttpRouter.use((router) =>
    router.addGlobalMiddleware((httpEffect) =>
      Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) => {
        const declared = Schema.decodeUnknownOption(NonNegativeIntFromString)(
          request.headers["content-length"]
        )
        return Option.getOrElse(declared, () => 0) > maxBytes
          ? Effect.succeed(HttpServerResponse.jsonUnsafe(
            { error: `Request body exceeds ${maxBytes} bytes` },
            { status: 413 }
          ))
          : httpEffect
      })))

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
                {
                  error: "The gateway could not complete this request",
                  ...whenPresent("traceId", traceId === "" ? undefined : traceId)
                },
                { status: 500 }
              )
          )
        }
      )))

export const defaultMaxBodyBytes = 1024 * 1024

export const gatewayAppLayer = (options: GatewayHandlerOptions) => {
  const optional = <Key extends string, T>(key: Key, value: T | undefined) =>
    whenPresent(key, value)

  const errorCapture = options.errorCapture === undefined
    ? ErrorCapture.logging
    : Layer.succeed(ErrorCapture, options.errorCapture)

  const dependencies = Layer.mergeAll(
    errorCapture,
    Layer.succeed(GatewayStoreService, options.store),
    Layer.succeedContext(options.hostServices),
    Layer.succeed(OAuthFlowSessions, options.oauth),
    Layer.succeed(GatewayConfig, {
      retentionDays: options.retentionDays,
      ...optional("dashboardUrl", options.dashboardUrl),
      ...optional("oauthCallbackUrl", options.oauthCallbackUrl),
      ...optional("mcpUrl", options.mcpUrl),
      ...optional("registryUrl", options.registryUrl)
    }),
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
    AuthLayer
  ).pipe(Layer.provide(dependencies))

  const platform = Layer.mergeAll(
    FileSystem.layerNoop({}),
    HttpPlatform.layer.pipe(Layer.provide(FileSystem.layerNoop({}))),
    HttpRouter.layer,
    Etag.layerWeak,
    Path.layer
  )
  const base = failureLayer().pipe(
    Layer.provideMerge(bodyLimitLayer(options.maxBodyBytes ?? defaultMaxBodyBytes)),
    Layer.provideMerge(platform),
    Layer.provideMerge(errorCapture)
  )
  return base.pipe(
    Layer.provideMerge(groups),
    Layer.provideMerge(Authority.layer({
      store: options.store,
      ...whenPresentMap("addressRateLimiter", options.addressRateLimiter, (l) => l),
      ...whenPresentMap("rateLimiter", options.rateLimiter, (l) => l)
    }))
  )
}



export interface GatewayHandle {
  handle(request: Request, context?: GatewayRequestContext): Promise<Response>
  dispose(): Promise<void>
}

export const createGatewayHandler = (options: GatewayHandlerOptions): GatewayHandle => {
  const mcp = createMcpGatewayHandler({
    store: options.store,
    hostServices: options.hostServices,
    httpClient: options.httpClient,
    retentionDays: options.retentionDays,
    ...whenPresent("dashboardUrl", options.dashboardUrl),
    ...whenPresent("errorCapture", options.errorCapture)
  })
  const app = HttpApiBuilder.layer(GatewayApi).pipe(
    Layer.provideMerge(gatewayAppLayer(options)),
    HttpRouter.provideRequest(options.httpClient)
  )
  const web = HttpEffect.toWebHandlerLayerWith(
    app.pipe(Layer.provide(Layer.merge(
      options.observabilityLayer ?? Layer.empty,
      HttpMiddleware.layerTracerDisabledForUrls(["/v1/health", "/v1/metadata"])
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
  return {
    handle: (request, requestContext) =>
      new URL(request.url).pathname === "/mcp"
        ? mcp.handle(request)
        : web.handler(request, contextFor(requestContext) ?? Context.empty()),
    dispose: async () => {
      await mcp.dispose()
      await web.dispose()
    }
  }
}
