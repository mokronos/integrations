import { whenPresent } from "@integragents/contracts"
import { Context, Effect, Layer } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { parseDestination } from "./url-policy.ts"
import type { UrlPolicy } from "./url-policy.ts"

/** Names the refused host only; an internal service's address is not something to hand back. */
export class DestinationRefused extends Error {
  constructor(readonly hostname: string) {
    super(`${hostname} is not a destination this gateway may reach`)
    this.name = "DestinationRefused"
  }
}

/** Sent on every outbound request that does not set its own; some edges refuse requests without one. */
export const gatewayUserAgent = "integrations-gateway"

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

/** Opens one connection to an already checked URL. Never follows redirects itself. */
export type Connect = (url: URL, init: RequestInit) => Promise<Response>

/** Workers have no resolver to consult; the platform's public-only fetch enforces addresses. */
export const platformConnect: Connect = (url, init) => globalThis.fetch(url, { ...init, redirect: "manual" })

const redirectStatuses = new Set([301, 302, 303, 307, 308])
const maxRedirects = 5

/** Headers that carry nothing about the caller, kept when a redirect leaves the origin. */
const crossOriginHeaders = new Set(["accept", "accept-language", "user-agent", "traceparent", "tracestate"])

const destination = (url: string, policy: UrlPolicy): URL => {
  const parsed = parseDestination(url, policy)
  if (parsed === undefined) throw new DestinationRefused(URL.parse(url)?.hostname ?? "The requested URL")
  return parsed
}

/**
 * A `fetch` that only reaches destinations `policy` allows, re-checking every
 * redirect hop. A redirect that leaves the origin drops every header that
 * could carry a credential; one that would replay a streamed body is returned
 * to the caller instead of followed.
 */
export const checkedFetch =
  (policy: UrlPolicy, connect: Connect): FetchLike =>
  async (input, init) => {
    const request = new Request(input, init)
    const mode = init?.redirect ?? request.redirect
    let url = destination(request.url, policy)
    let method = request.method
    let body: BodyInit | null = request.body
    let headers = new Headers(request.headers)
    for (let hop = 0; ; hop++) {
      request.signal.throwIfAborted()
      const response = await connect(url, {
        method,
        headers,
        body,
        signal: request.signal,
        redirect: "manual",
        ...whenPresent("duplex", body === null ? undefined : "half")
      })
      const location = response.headers.get("location")
      if (!redirectStatuses.has(response.status) || location === null || mode === "manual") return response
      if (mode === "error") throw new TypeError(`Redirected to ${location}`)
      if (hop >= maxRedirects) throw new TypeError("Too many redirects")
      const next = destination(new URL(location, url).href, policy)
      const switchesToGet =
        response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")
      if (switchesToGet) {
        method = method === "HEAD" ? "HEAD" : "GET"
        body = null
        headers.delete("content-type")
        headers.delete("content-length")
      } else if (body !== null) {
        return response
      }
      if (next.origin !== url.origin) {
        headers = new Headers([...headers].filter(([name]) => crossOriginHeaders.has(name.toLowerCase())))
      }
      await response.body?.cancel()
      url = next
    }
  }

/**
 * Every request the gateway sends on a user's behalf: the policy it is held
 * to and a `fetch` enforcing it, for libraries that take a `fetch` rather
 * than an `HttpClient`.
 */
export class Egress extends Context.Service<
  Egress,
  {
    readonly policy: UrlPolicy
    readonly fetch: FetchLike
  }
>()("@integragents/integrations/Egress") {
  /**
   * The egress service and an `HttpClient` that goes through it. `connect`
   * is the platform's: `platformConnect` on Workers, the address-checking one
   * from `@integragents/integrations/native-egress` where a resolver is available.
   */
  static readonly layer = (
    policy: UrlPolicy,
    connect: Connect = platformConnect
  ): Layer.Layer<Egress | HttpClient.HttpClient> => {
    const fetch = checkedFetch(policy, connect)
    return Layer.merge(
      Layer.succeed(Egress, { policy, fetch }),
      Layer.effect(
        HttpClient.HttpClient,
        Effect.map(HttpClient.HttpClient, (client) =>
          client.pipe(HttpClient.transformResponse(Effect.provideService(FetchHttpClient.Fetch, fetch)))
        )
      ).pipe(Layer.provide(FetchHttpClient.layer))
    )
  }
}
