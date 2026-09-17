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
import { defaultMaxUploadBytes, NonNegativeIntFromString, whenPresent } from "@integrations/contracts"
import type { IntegrationServices } from "@integrations/integrations"
import { GatewayStoreService } from "@integrations/gateway-core"
import { webCryptoLayer } from "@integrations/contracts"
import type { GatewayStore } from "@integrations/gateway-core"
import type { OAuthSessions } from "@integrations/gateway-core"
import type { WebAssets } from "../web-assets.ts"
import { createMcpGatewayHandler } from "./mcp.ts"

export interface GatewayRequestContext {
  readonly localSecret?: string
  readonly remoteAddress?: string
}

export type GatewayCoreServices = GatewayStoreService | IntegrationServices | OAuthFlowSessions

export const gatewayServicesContext = (input: {
  readonly store: GatewayStore
  readonly integrationServices: Context.Context<IntegrationServices>
  readonly oauth: OAuthSessions
}): Context.Context<GatewayCoreServices> =>
  input.integrationServices.pipe(
    Context.add(GatewayStoreService, input.store),
    Context.add(OAuthFlowSessions, input.oauth)
  )

export interface GatewayHandlerOptions extends GatewaySettings {
  readonly store: GatewayStore
  readonly integrationServices: Context.Context<IntegrationServices>
  readonly httpClient: Layer.Layer<HttpClient.HttpClient>
  readonly oauth: OAuthSessions
  /** Who is calling. Defaults to the gateway's own keys, sessions, and local credential. */
  readonly authority?: Layer.Layer<Authority, never, GatewayStoreService>
  readonly sessions?: SignInPolicy
  readonly rateLimits?: RateLimits
  readonly maxBodyBytes?: number
  readonly maxUploadBytes?: number
  readonly webAssets?: WebAssets
  readonly observabilityLayer?: Layer.Layer<never>
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

  const services = Layer.succeedContext(gatewayServicesContext(options))
  const dependencies = Layer.mergeAll(
    errorCapture,
    services,
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



export interface GatewayHandle {
  handle(request: Request, context?: GatewayRequestContext): Promise<Response>
  dispose(): Promise<void>
}

export const createGatewayHandler = (options: GatewayHandlerOptions): GatewayHandle => {
  const app = HttpApiBuilder.layer(GatewayApi).pipe(
    Layer.provideMerge(gatewayAppLayer(options)),
    HttpRouter.provideRequest(Layer.merge(options.httpClient, webCryptoLayer))
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
  // The MCP surface answers by calling the API it sits in front of, so its
  // tools cannot drift from the routes the CLI and clients already use.
  const mcp = createMcpGatewayHandler({
    store: options.store,
    dispatch: (request) => web.handler(request, Context.empty()),
    ...whenPresent("errorCapture", options.errorCapture)
  })
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
