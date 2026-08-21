import { Schema } from "effect"
import type { Client, SessionTokenHash, SubjectId, TenantId } from "../domain.ts"

/** Routes are data rather than an if-chain over pathnames, so the surface can
 * be enumerated, access-classified, and tested without a socket.
 *
 * This deliberately does not use Effect's HttpApi: the gateway is published,
 * and pinning it to a beta HTTP surface would propagate that instability to
 * every consumer. What the if-chain actually cost us was type safety at the
 * boundary, and a route table with Schema-decoded bodies buys that back. */
export type HttpVerb = "GET" | "POST" | "DELETE"

/** `delegated` needs any live key; `privileged` additionally needs mayMutate —
 * or a human session, since administering the gateway is exactly what the
 * dashboard exists for. `public` needs neither: the login surface cannot
 * require the credential it creates. Classification lives on the route so a
 * new endpoint cannot forget to be guarded — the dispatcher reads this, not
 * the handler. */
export type RouteAccess = "public" | "delegated" | "privileged"

/** Who the dispatcher decided this request is. Every authenticated request is
 * exactly one of these; there is no blending of a session and a key. `refused`
 * means a credential was presented and rejected — protected routes turn that
 * into the exact refusal, public routes treat it as anonymous. */
export type RouteIdentity =
  | { readonly kind: "anonymous" }
  | {
    readonly kind: "refused"
    readonly reason: "unknown-key" | "key-revoked" | "client-revoked"
  }
  | { readonly kind: "client"; readonly client: Client; readonly secret: string }
  | {
    readonly kind: "session"
    readonly tenantId: TenantId
    readonly subjectId: SubjectId
    readonly email: string
    /** The hash of the cookie's token, so logout can revoke server-side rather
     *  than only dropping the cookie. */
    readonly tokenHash: SessionTokenHash
  }

export type RouteRequest = {
  readonly params: Readonly<Record<string, string>>
  readonly query: URLSearchParams
  /** Already parsed from the request's JSON text by the handler, so a route
   *  never sees a raw string. */
  readonly body: Schema.Json
  readonly identity: RouteIdentity
}

/** The API client behind this request. The dispatcher only hands a route its
 *  declared identity class, so a handler whose route is `delegated` or
 *  `privileged` may assert this; a stray call on a public route is a bug and
 *  fails loudly instead of authorizing nobody. */
export const clientOf = (request: RouteRequest): Client => {
  if (request.identity.kind !== "client") {
    throw new Error(`A client identity is required, got ${request.identity.kind}`)
  }
  return request.identity.client
}

/** The presented API key. Only meaningful alongside {@link clientOf}. */
export const secretOf = (request: RouteRequest): string => {
  if (request.identity.kind !== "client") {
    throw new Error(`A client secret is required, got ${request.identity.kind}`)
  }
  return request.identity.secret
}

/** The tenant this request acts within: the client's partition, or the signed-in
 *  human's. Every tenant-scoped read goes through here so a session and a key
 *  see the same slice of the world. */
export const tenantOf = (request: RouteRequest): TenantId => {
  switch (request.identity.kind) {
    case "client":
      return request.identity.client.tenantId
    case "session":
      return request.identity.tenantId
    default:
      throw new Error(`A tenant is required, got identity ${request.identity.kind}`)
  }
}

/** The signed-in human behind this request, if there is one. Used for display
 *  and attribution — `decidedBy` on an approval — never for authority. */
export const sessionOf = (request: RouteRequest): { readonly email: string } | undefined =>
  request.identity.kind === "session" ? request.identity : undefined

/** A value on its way out through JSON.stringify.
 *
 *  Wider than Schema.Json on purpose: the handlers return decoded domain
 *  records, and those carry Dates (which stringify turns into ISO strings) and
 *  optional properties typed `| undefined` (which stringify drops). Naming that
 *  is the difference between a response contract and `unknown`. */
export type JsonEncodable =
  | Schema.Json
  | undefined
  | Date
  | ReadonlyArray<JsonEncodable>
  | { readonly [key: string]: JsonEncodable }

export interface RouteResult {
  readonly status: number
  readonly body: JsonEncodable
  /** Extra response headers — `Set-Cookie` for the session surface, which
   *  cannot be expressed as JSON. */
  readonly headers?: Readonly<Record<string, string>>
  /** When set, sent verbatim as `text/html` instead of serialising `body`.
   *  For the browser-facing endpoints (the OAuth callback) whose reader is a
   *  human on a redirect, not an API client. */
  readonly html?: string
}

export interface Route {
  readonly method: HttpVerb
  /** Segments prefixed with `:` are captured, e.g. `/v1/grants/:id/revoke`. */
  readonly path: string
  readonly access: RouteAccess
  readonly handle: (request: RouteRequest) => Promise<RouteResult>
}

export const ok = (body: JsonEncodable): RouteResult => ({ status: 200, body })
export const created = (body: JsonEncodable): RouteResult => ({ status: 201, body })
export const badRequest = (message: string): RouteResult => ({
  status: 400,
  body: { error: message }
})
export const notFound = (message: string): RouteResult => ({
  status: 404,
  body: { error: message }
})

export interface RouteMatch {
  readonly route: Route
  readonly params: Readonly<Record<string, string>>
}

const segments = (path: string): ReadonlyArray<string> =>
  path.split("/").filter((segment) => segment.length > 0)

export const matchRoute = (
  routes: ReadonlyArray<Route>,
  method: string,
  pathname: string
): RouteMatch | undefined => {
  const requested = segments(pathname)
  for (const route of routes) {
    if (route.method !== method) continue
    const pattern = segments(route.path)
    if (pattern.length !== requested.length) continue
    const params: Record<string, string> = {}
    let matched = true
    for (const [index, part] of pattern.entries()) {
      const actual = requested[index]
      if (actual === undefined) {
        matched = false
        break
      }
      if (part.startsWith(":")) {
        params[part.slice(1)] = decodeURIComponent(actual)
        continue
      }
      if (part !== actual) {
        matched = false
        break
      }
    }
    if (matched) return { route, params }
  }
  return undefined
}

/** Whether any route exists at this path under a different verb, so a wrong
 *  method reports 405 rather than a misleading 404. */
export const pathExists = (
  routes: ReadonlyArray<Route>,
  pathname: string
): boolean =>
  routes.some((route) => matchRoute([route], route.method, pathname) !== undefined)

export class RequestBodyError extends Error {
  /** 400 for malformed bodies, 413 for oversized ones — both are boundary
   *  refusals, but only one means "try again with less". */
  readonly status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

/** Decodes a request body at the boundary. Handlers receive parsed values and
 *  never inspect `unknown`. */
export const decodeBody = <A>(schema: Schema.Codec<A>, body: Schema.Json): A => {
  try {
    return Schema.decodeUnknownSync(schema)(body)
  } catch (error) {
    throw new RequestBodyError(
      error instanceof Error ? error.message : "Request body did not match the expected shape"
    )
  }
}
