import { Context, Effect } from "effect"
import { HttpTraceContext } from "effect/unstable/http"

/**
 * A `fetch` for libraries that insist on one: each request gets a client span
 * under whatever span was current in `context`, and carries its trace headers.
 */
export const tracedFetch = (
  context: Context.Context<never>
) =>
(url: string | URL, init?: RequestInit): Promise<Response> => {
  const method = (init?.method ?? "GET").toUpperCase()
  const target = new URL(url)
  return Effect.runPromiseWith(context)(Effect.useSpan(
    `http.client ${method}`,
    {
      kind: "client",
      attributes: {
        "http.request.method": method,
        "server.address": target.hostname,
        "url.full": `${target.origin}${target.pathname}`
      }
    },
    (span) => {
      const headers = new globalThis.Headers(init?.headers)
      for (const [name, value] of Object.entries(HttpTraceContext.toHeaders(span))) {
        headers.set(name, value)
      }
      return Effect.promise(() => fetch(url, { ...init, headers })).pipe(
        Effect.tap((response) => Effect.sync(() => span.attribute("http.response.status_code", response.status)))
      )
    }
  ))
}
