import type { JsonObject } from "@mokronos/contracts"
import {
  gatewayProtocolVersion
} from "@mokronos/contracts"
import { Effect, Result } from "effect"
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

const json = (status: number, body: JsonObject): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.jsonUnsafe(body, { status })

const withResponseHeader = (name: string, value: string) =>
  HttpEffect.appendPreResponseHandler((_request, response) =>
    Effect.succeed(HttpServerResponse.setHeader(response, name, value)))

export const SystemLayer = HttpApiBuilder.group(GatewayApi, "system", (handlers) =>
  handlers
    .handle("health", () => Effect.succeed({ ok: true }))
    .handle("metadata", () =>
      Effect.gen(function*() {
        yield* withResponseHeader("cache-control", "no-store")
        return { ok: true as const, protocolVersion: gatewayProtocolVersion, gatewayVersion }
      })))

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
    const rawUrl = request.url
    const pathname = rawUrl.startsWith("/")
      ? rawUrl.split("?")[0] ?? rawUrl
      : new URL(rawUrl).pathname
    const method = request.method === "HEAD" ? "GET" : request.method
    if (webAssets !== undefined && method === "GET" && !pathname.startsWith("/v1/")) {
      const asset = yield* Effect.result(webAssets.respond)
      if (Result.isSuccess(asset)) return asset.success
    }
    if (pathIsKnown(pathname)) {
      return json(405, { error: `${request.method} is not allowed on ${pathname}` })
    }
    return json(404, { error: `No route for ${request.method} ${pathname}` })
  })

export const FallbackLayer = HttpApiBuilder.group(GatewayApi, "fallback", (handlers) =>
  Effect.gen(function*() {
    const { assets } = yield* ControlPlaneAssets
    return handlers
      .handle("unmatchedGet", () => unmatched(assets))
      .handle("unmatchedPost", () => unmatched(undefined))
      .handle("unmatchedDelete", () => unmatched(undefined))
  }))
