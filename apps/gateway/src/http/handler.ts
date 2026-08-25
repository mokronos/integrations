import { Cause, Context, Effect, Layer, Result } from "effect"
import { FileSystem, Path } from "effect"
import {
  Etag,
  HttpEffect,
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
  SystemLayer,
  type GatewayDependencies
} from "./handlers.ts"
import { whenPresent, whenPresentMap } from "@mokronos/contracts"
import type { WebAssets } from "../web-assets.ts"
import type { RateLimiter } from "../ratelimit.ts"

export type { GatewayDependencies }

/** What the server knows about a request that the request itself cannot say.
 *  Carried per request through the web-handler seam; the served gateway
 *  derives it instead — see {@link deriveRequestContext}. */
export interface GatewayRequestContext {
  readonly localSecret?: string
  readonly remoteAddress?: string
}

export interface GatewayHandlerOptions extends GatewayDependencies {
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
}

/** Refuses oversized declared bodies before any handler or authority work.
 *  Chunked bodies without a declared length are not bounded here — every real
 *  client (browsers, fetch, the worker runtime) declares one. */
const bodyLimitLayer = (maxBytes: number) =>
  HttpRouter.use((router) =>
    router.addGlobalMiddleware((httpEffect) =>
      Effect.flatMap(HttpServerRequest.HttpServerRequest.asEffect(), (request) => {
        const declared = request.headers["content-length"]
        return declared !== undefined && Number.parseInt(declared, 10) > maxBytes
          ? Effect.succeed(HttpServerResponse.jsonUnsafe(
            { error: `Request body exceeds ${maxBytes} bytes` },
            { status: 413 }
          ))
          : httpEffect
      })))

/** Turns request-shape refusals (malformed JSON, payloads that miss their
 *  schema, bad path parameters) into the gateway's ordinary `{error}` dialect
 *  instead of an empty 400. */
const schemaErrorsLayer = () =>
  HttpRouter.use((router) =>
    router.addGlobalMiddleware((httpEffect) =>
      Effect.catchCauseIf(
        httpEffect,
        (cause) => {
          const defect = Cause.findDefect(cause)
          return Result.isSuccess(defect) && HttpApiSchemaError.is(defect.success)
        },
        (cause) => {
          const defect = Cause.findDefect(cause)
          // The predicate guarantees this is a schema error.
          const schemaError = Result.isSuccess(defect) && HttpApiSchemaError.is(defect.success)
            ? defect.success
            : undefined
          return Effect.succeed(HttpServerResponse.jsonUnsafe(
            {
              error: schemaError?.cause instanceof Error
                ? schemaError.cause.message
                : "Request body did not match the expected shape"
            },
            { status: 400 }
          ))
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
  const dashboardUrl = optional("dashboardUrl", options.dashboardUrl)
  const oauthCallbackUrl = optional("oauthCallbackUrl", options.oauthCallbackUrl)
  const registryUrl = optional("registryUrl", options.registryUrl)

  const groups = Layer.mergeAll(
    SystemLayer,
    FallbackLayer(whenPresentMap("webAssets", options.webAssets, (assets) => assets)),
    DelegatedLayer({
      store: options.store,
      integrations: options.integrations,
      retentionDays: options.retentionDays,
      ...dashboardUrl
    }),
    ProvisioningLayer({
      store: options.store,
      integrations: options.integrations,
      oauth: options.oauth,
      ...oauthCallbackUrl,
      ...registryUrl
    }),
    AdministrativeLayer({
      store: options.store,
      integrations: options.integrations,
      retentionDays: options.retentionDays
    }),
    AuthLayer({
      store: options.store,
      sessions: options.sessions ?? {
        signupOpen: async () => false,
        secureCookies: false
      }
    })
  )
  // The FileSystem stays in the outputs as well: the API builder requires one
  // even though every response here is JSON.
  const platform = Layer.mergeAll(
    FileSystem.layerNoop({}),
    HttpPlatform.layer.pipe(Layer.provide(FileSystem.layerNoop({}))),
    HttpRouter.layer,
    Etag.layerWeak,
    Path.layer
  )
  const base = schemaErrorsLayer()
    .pipe(Layer.provideMerge(bodyLimitLayer(options.maxBodyBytes ?? defaultMaxBodyBytes)))
    .pipe(Layer.provideMerge(platform))
  return base
    .pipe(Layer.provideMerge(groups))
    .pipe(Layer.provideMerge(Authority.layer({
      store: options.store,
      ...whenPresentMap("addressRateLimiter", options.addressRateLimiter, (l) => l),
      ...whenPresentMap("rateLimiter", options.rateLimiter, (l) => l)
    })))
}



export interface GatewayHandle {
  handle(request: Request, context?: GatewayRequestContext): Promise<Response>
  dispose(): Promise<void>
}

/** Builds the API once and answers requests against it without owning a
 *  socket — the seam the Cloudflare Worker, acceptance tests, and any embedded
 *  consumer drive directly. */
export const createGatewayHandler = (options: GatewayHandlerOptions): GatewayHandle => {
  // The API builder's requirements (groups, router, platform services) are all
  // satisfied by the app layer's outputs, and its outputs keep them.
  const app = HttpApiBuilder.layer(GatewayApi).pipe(
    Layer.provideMerge(gatewayAppLayer(options))
  )
  const web = HttpEffect.toWebHandlerLayerWith(app, {
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
      web.handler(request, contextFor(requestContext) ?? Context.empty()),
    dispose: () => web.dispose()
  }
}
