import type { JsonObject } from "@mokronos/contracts"
import {
  gatewayProtocolVersion
} from "@mokronos/contracts"
import { Effect } from "effect"
import { HttpEffect, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { gatewayVersion } from "../../version.ts"
import type { WebAssets } from "../../web-assets.ts"
import {
  GatewayApi
} from "../api.ts"
import {
  ControlPlaneAssets
} from "../services.ts"

/** Handlers for every endpoint in {@link GatewayApi}.
 *
 *  Each group layer asks the context for what it needs and bridges to the
 *  existing async domain code; those bridges shrink as the domain and store
 *  become Effects themselves. */

const json = (status: number, body: JsonObject): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.jsonUnsafe(body, { status })

/** Sets a response header without giving up the endpoint's declared schema:
 *  the handler still returns its typed value and the API still encodes it. */
const withResponseHeader = (name: string, value: string) =>
  HttpEffect.appendPreResponseHandler((_request, response) =>
    Effect.succeed(HttpServerResponse.setHeader(response, name, value)))

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

