import { Cause, Context, Effect, Layer, Option, Result, Schema } from "effect"
import { FileSystem, Path } from "effect"
import {
  Etag,
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
import type { GatewaySettings, SignInPolicy } from "./services.ts"
import { NonNegativeIntFromString, whenPresent, whenPresentMap } from "@mokronos/contracts"
import { IntegrationsApiService } from "@mokronos/integrations"
import type { IntegrationsApi } from "@mokronos/integrations"
import { GatewayStoreService } from "@mokronos/gateway-core"
import type { GatewayStore } from "@mokronos/gateway-core"
import type { OAuthSessions } from "@mokronos/gateway-core"
import type { WebAssets } from "../web-assets.ts"
import type { RateLimiter } from "@mokronos/gateway-core"
import { createMcpGatewayHandler } from "./mcp.ts"

/** What the server knows about a request that the request itself cannot say.
 *  Carried per request through the web-handler seam; the served gateway
 *  derives it instead — see {@link deriveRequestContext}. */
export interface GatewayRequestContext {
  readonly localSecret?: string
  readonly remoteAddress?: string
}

/** The seam every embedding takes: the worker, the served gateway, and the
 *  tests all hand over plain values here and this module turns them into the
 *  layers the handlers ask for. Callers should not have to know that the HTTP
 *  layer runs on Effect services. */
export interface GatewayHandlerOptions extends GatewaySettings {
  readonly store: GatewayStore
  readonly integrations: IntegrationsApi
  readonly oauth: OAuthSessions
  readonly sessions?: SignInPolicy
  /** Two buckets with distinct key spaces: a per-address limit before
   *  authentication protects the credential machinery itself, and a
   *  per-principal limit after it keeps one misbehaving client from starving
   *  its neighbours. */
  readonly addressRateLimiter?: RateLimiter
  readonly rateLimiter?: RateLimiter
  /** Largest accepted JSON body in bytes. Declared sizes are refused before a
   *  byte is read; defaults to one mebibyte. */
  readonly maxBodyBytes?: number
  /** Serves the control plane's own files for unmatched non-`/v1` paths. */
  readonly webAssets?: WebAssets
  readonly observabilityLayer?: Layer.Layer<never>
}

/** Refuses oversized declared bodies before any handler or authority work.
 *  Chunked bodies without a declared length are not bounded here — every real
 *  client (browsers, fetch, the worker runtime) declares one. */
const bodyLimitLayer = (maxBytes: number) =>
  HttpRouter.use((router) =>
    router.addGlobalMiddleware((httpEffect) =>
      Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) => {
        // A length that is absent or unreadable is not a length over the limit,
        // so it falls through to the handler like any undeclared body.
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

/** The single answer to a request that failed rather than returned.
 *
 *  Two kinds arrive here, and telling them apart is the whole job. A schema
 *  refusal is the caller's — a malformed body, a bad path parameter — and
 *  saying which field is wrong is the useful thing to do. Anything else is
 *  ours: a rejected driver call, a bug. That one is logged and answered
 *  incuriously, because a libsql error carries the database path and a stack
 *  trace carries the layout of the deployment.
 *
 *  Both were previously invisible: an undeclared failure reached the router as
 *  a defect and became a 500 with an empty body, which is the one failure shape
 *  no client can read. */
const failureLayer = () =>
  HttpRouter.use((router) =>
    router.addGlobalMiddleware((httpEffect) =>
      Effect.catchCauseIf(
        httpEffect,
        // Interruption is the server shutting down or a client hanging up.
        // Neither is a failure to report.
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
          return Effect.as(
            Effect.logError("Unhandled gateway failure", cause),
            HttpServerResponse.jsonUnsafe(
              { error: "The gateway could not complete this request" },
              { status: 500 }
            )
          )
        }
      )))

/** The one place that decides what an unmatched non-`/v1` path means: on a
 *  deployment with a control plane it is a file, otherwise a JSON 404/405 that
 *  says which paths do exist.
 *
 *  Composition order matters twice over: platform services come before the
 *  groups so group requirements are subtracted against them, and the authority
 *  layer exists before any group builds, because middleware services are
 *  captured from the context a group layer builds in. */
export const defaultMaxBodyBytes = 1024 * 1024

export const gatewayAppLayer = (options: GatewayHandlerOptions) => {
  const optional = <Key extends string, T>(key: Key, value: T | undefined) =>
    whenPresent(key, value)

  // Everything the handlers ask for, provided once here rather than threaded
  // through six factory calls.
  const dependencies = Layer.mergeAll(
    Layer.succeed(GatewayStoreService, options.store),
    Layer.succeed(IntegrationsApiService, options.integrations),
    Layer.succeed(OAuthFlowSessions, options.oauth),
    Layer.succeed(GatewayConfig, {
      retentionDays: options.retentionDays,
      ...optional("dashboardUrl", options.dashboardUrl),
      ...optional("oauthCallbackUrl", options.oauthCallbackUrl),
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

  // The FileSystem stays in the outputs as well: the API builder requires one
  // even though every response here is JSON.
  const platform = Layer.mergeAll(
    FileSystem.layerNoop({}),
    HttpPlatform.layer.pipe(Layer.provide(FileSystem.layerNoop({}))),
    HttpRouter.layer,
    Etag.layerWeak,
    Path.layer
  )
  const base = failureLayer().pipe(
    Layer.provideMerge(bodyLimitLayer(options.maxBodyBytes ?? defaultMaxBodyBytes)),
    Layer.provideMerge(platform)
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

/** Builds the API once and answers requests against it without owning a
 *  socket — the seam the Cloudflare Worker, acceptance tests, and any embedded
 *  consumer drive directly. */
export const createGatewayHandler = (options: GatewayHandlerOptions): GatewayHandle => {
  const mcp = createMcpGatewayHandler({
    store: options.store,
    integrations: options.integrations,
    retentionDays: options.retentionDays,
    ...whenPresent("dashboardUrl", options.dashboardUrl)
  })
  // The API builder's requirements (groups, router, platform services) are all
  // satisfied by the app layer's outputs, and its outputs keep them.
  const app = HttpApiBuilder.layer(GatewayApi).pipe(
    Layer.provideMerge(gatewayAppLayer(options))
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
