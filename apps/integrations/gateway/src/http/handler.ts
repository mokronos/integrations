import { Schema } from "effect"
import { whenPresent } from "@mokronos/wfkit"
import { authenticateClient, authorizeMutation } from "../authorize.ts"
import { hashSessionToken } from "../passwords.ts"
import { SessionTokenHash } from "../domain.ts"
import type { RateLimiter } from "../ratelimit.ts"
import type { GatewayStore } from "../store.ts"
import { matchRoute, pathExists, RequestBodyError } from "./router.ts"
import type { JsonEncodable, RouteIdentity } from "./router.ts"
import type { Route } from "./router.ts"

const sessionCookieName = "wf_session"

/** Reads one cookie out of the `Cookie` header, if present. */
export const readSessionCookie = (request: Request): string | undefined => {
  const header = request.headers.get("cookie")
  if (header === null) return undefined
  for (const part of header.split(";")) {
    const equals = part.indexOf("=")
    if (equals === -1) continue
    if (part.slice(0, equals).trim() === sessionCookieName) {
      const value = part.slice(equals + 1).trim()
      return value.length === 0 ? undefined : value
    }
  }
  return undefined
}

export const sessionCookieHeader = (token: string, options: {
  readonly maxAgeSeconds: number
  readonly secure: boolean
}): string =>
  `${sessionCookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${options.maxAgeSeconds}${options.secure ? "; Secure" : ""}`

export const clearedSessionCookieHeader = (options: { readonly secure: boolean }): string =>
  `${sessionCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${options.secure ? "; Secure" : ""}`

const json = (
  status: number,
  body: JsonEncodable,
  headers?: Readonly<Record<string, string>>
): Response =>
  new Response(`${JSON.stringify(body)}\n`, {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers }
  })

const tooManyRequests = (retryAfterSeconds: number): Response =>
  json(429, {
    error: `Too many requests; retry in ${retryAfterSeconds} seconds`,
    code: "rate-limited"
  }, { "retry-after": String(retryAfterSeconds) })

/** `Authorization: Bearer <key>`, or the `x-api-key` header. Nothing reads a
 *  key from the query string, where it would land in access logs. */
const presentedSecret = (request: Request): string | undefined => {
  const header = request.headers.get("authorization")
  if (header !== null) {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim())
    if (match?.[1] !== undefined) return match[1]
  }
  const apiKey = request.headers.get("x-api-key")
  return apiKey === null || apiKey.length === 0 ? undefined : apiKey
}

const readBody = async (request: Request, maxBytes: number): Promise<Schema.Json> => {
  if (request.method === "GET" || request.method === "DELETE") return {}
  const declared = request.headers.get("content-length")
  // Refuse before reading when the size is declared; otherwise the read below
  // is bounded by a post-read check.
  if (declared !== null && Number.parseInt(declared, 10) > maxBytes) {
    throw new RequestBodyError(`Request body exceeds ${maxBytes} bytes`, 413)
  }
  const text = await request.text()
  if (text.length > maxBytes) {
    throw new RequestBodyError(`Request body exceeds ${maxBytes} bytes`, 413)
  }
  if (text.trim().length === 0) return {}
  try {
    return Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(text)
  } catch {
    throw new RequestBodyError("Request body is not valid JSON")
  }
}

export const defaultMaxBodyBytes = 1024 * 1024

/** Every way a credential can be refused. Naming the union instead of keying
 *  these tables by `string` makes both of them total, so a new refusal reason
 *  cannot be introduced without also giving it a status code and a sentence. */
type RefusalStatus =
  | "unknown-key"
  | "key-revoked"
  | "client-revoked"
  | "not-permitted"

const refusalStatus = {
  "unknown-key": 401,
  "key-revoked": 401,
  "client-revoked": 403,
  "not-permitted": 403
} satisfies Record<RefusalStatus, number>

const refusalMessage = {
  "unknown-key": "This API key is not known to the gateway",
  "key-revoked": "This API key was revoked",
  "client-revoked": "The client this key belongs to was revoked",
  "not-permitted": "This key may not change the catalog, connections, grants, or policy"
} satisfies Record<RefusalStatus, string>

/** A refusal states both a sentence and a `code`. Clients branch on the code:
 *  matching on prose is how "not granted" ends up being explained to a user as
 *  a permissions-tier problem. */
const refusal = (status: RefusalStatus): Response =>
  json(refusalStatus[status], { error: refusalMessage[status], code: status })

export interface HandlerDependencies {
  readonly store: GatewayStore
  readonly routes: ReadonlyArray<Route>
  /** Optional traffic shaping, in two buckets with distinct key spaces: a
   *  per-address limit before authentication protects the credential machinery
   *  itself, and a per-principal limit after it keeps one misbehaving client
   *  from starving its neighbours. */
  readonly addressRateLimiter?: RateLimiter
  readonly rateLimiter?: RateLimiter
  readonly maxBodyBytes?: number
}

/** What the server knows about a request that the request itself cannot say.
 *
 * `localSecret` is the local client's key, and is set only by a server that has
 * already decided this request may borrow it — see `http/loopback.ts`. The
 * handler does not re-derive that decision, so a caller cannot reach it by
 * setting a header. `remoteAddress` feeds the pre-authentication rate bucket;
 * without it those requests share one anonymous key. */
export interface GatewayRequestContext {
  readonly localSecret?: string
  readonly remoteAddress?: string
}

/** Decides who a request is, from at most one credential source.
 *
 * Precedence is by trust, not by header order: an explicitly presented key
 * always speaks for itself; the session cookie is consulted only when no key
 * was presented, since a dashboard page holds a cookie and never a key; the
 * borrowed local credential is last, and only arrives here pre-approved.
 * Anything presented but not accepted becomes a `refused` identity carrying
 * *why*, so protected routes can give the exact refusal and public routes can
 * ignore credentials entirely. */
const resolveIdentity = async (
  dependencies: HandlerDependencies,
  request: Request,
  context: GatewayRequestContext | undefined
): Promise<RouteIdentity> => {
  const secret = presentedSecret(request)
  if (secret !== undefined) {
    const authentication = await authenticateClient(dependencies.store, secret)
    return authentication.status === "authenticated"
      ? { kind: "client", client: authentication.client, secret }
      : { kind: "refused", reason: authentication.status }
  }

  const token = readSessionCookie(request)
  if (token !== undefined) {
    const session = await dependencies.store.findLiveSession(
      SessionTokenHash.make(hashSessionToken(token))
    )
    if (session !== undefined) {
      return {
        kind: "session",
        tenantId: session.tenantId,
        subjectId: session.subjectId,
        email: session.email,
        tokenHash: session.tokenHash
      }
    }
    return { kind: "anonymous" }
  }

  if (context?.localSecret !== undefined) {
    const authentication = await authenticateClient(dependencies.store, context.localSecret)
    if (authentication.status === "authenticated") {
      return { kind: "client", client: authentication.client, secret: context.localSecret }
    }
  }

  return { kind: "anonymous" }
}

/** Cookie-carried credentials need the browser's own attestation that this
 *  request came from our origin; that is what stops another site from making
 *  the browser spend the session. A key in a header needs nothing here — cross-
 *  site script cannot read it out of another origin's storage to begin with. */
const cookieRequestIsSameOrigin = (request: Request): boolean => {
  const fetchSite = request.headers.get("sec-fetch-site")?.trim().toLowerCase()
  if (fetchSite === "same-origin" || fetchSite === "none") return true
  const origin = request.headers.get("origin")
  const host = request.headers.get("host")
  if (origin === null || host === null) return false
  try {
    return new URL(origin).host === host.trim().toLowerCase()
  } catch {
    return false
  }
}

/** Turns a Request into a Response with no socket involved, so the whole
 * surface — including every rejection path — is testable directly.
 *
 * Access is enforced here rather than in handlers: a route declares whether it
 * is public, delegated, or privileged, and a new endpoint cannot forget to
 * check. */
export const createGatewayHandler = (
  dependencies: HandlerDependencies
): ((request: Request, context?: GatewayRequestContext) => Promise<Response>) =>
async (request, context) => {
  const url = new URL(request.url)

  if (url.pathname === "/v1/health") {
    return json(200, { ok: true })
  }

  if (dependencies.addressRateLimiter !== undefined) {
    // Before authentication, so guessing credentials costs a bucket slot per
    // attempt rather than a key lookup.
    const addressVerdict = dependencies.addressRateLimiter.take(
      `addr:${context?.remoteAddress ?? "unknown"}`
    )
    if (!addressVerdict.allowed) {
      return tooManyRequests(addressVerdict.retryAfterSeconds)
    }
  }

  const matched = matchRoute(dependencies.routes, request.method, url.pathname)
  if (matched === undefined) {
    return pathExists(dependencies.routes, url.pathname)
      ? json(405, { error: `${request.method} is not allowed on ${url.pathname}` })
      : json(404, { error: `No route for ${request.method} ${url.pathname}` })
  }
  const { route, params } = matched

  const identity = await resolveIdentity(dependencies, request, context)

  if (dependencies.rateLimiter !== undefined &&
    identity.kind !== "anonymous" && identity.kind !== "refused") {
    const principalKey = identity.kind === "client"
      ? `client:${identity.client.id}`
      : `subject:${identity.subjectId}`
    const verdict = dependencies.rateLimiter.take(principalKey)
    if (!verdict.allowed) {
      return tooManyRequests(verdict.retryAfterSeconds)
    }
  }

  // A session riding a cookie must prove same-origin for anything but a read,
  // whatever route it is headed for.
  if (identity.kind === "session" && request.method !== "GET" && !cookieRequestIsSameOrigin(request)) {
    return json(403, { error: "Cross-site requests are not permitted", code: "cross-site" })
  }

  if (route.access === "public") {
    // Public routes decide for themselves what an absent identity means; the
    // login surface cannot require the credential it creates.
    return await dispatch(route, url, identity)
  }

  // Humans administer through the dashboard; machines invoke through keys. A
  // session never reaches the delegated surface — issuing a client key is how
  // a human delegates.
  if (identity.kind === "session") {
    if (route.access !== "privileged") {
      return json(403, {
        error: "A signed-in session may not invoke tools; issue a client key instead",
        code: "not-permitted"
      })
    }
    return await dispatch(route, url, identity)
  }

  if (identity.kind === "refused") return refusal(identity.reason)

  if (identity.kind === "anonymous") {
    return json(401, { error: "An API key is required", code: "unknown-key" })
  }

  // Privileged routes ask a different question than delegated ones: not "may
  // you invoke this" but "may you change what is invocable".
  if (route.access === "privileged") {
    const authorization = await authorizeMutation(dependencies.store, identity.secret)
    if (authorization.status !== "authorized") return refusal(authorization.status)
  }

  return await dispatch(route, url, identity)

  async function dispatch(
    route: Route,
    location: URL,
    identity: RouteIdentity
  ): Promise<Response> {
    try {
      const result = await route.handle({
        params,
        query: location.searchParams,
        body: await readBody(request, dependencies.maxBodyBytes ?? defaultMaxBodyBytes),
        identity
      })
      if (result.html !== undefined) {
        return new Response(result.html, {
          status: result.status,
          headers: {
            "content-type": "text/html; charset=utf-8",
            ...whenPresent("content-type", result.headers?.["content-type"])
          }
        })
      }
      return json(result.status, result.body, result.headers)
    } catch (error) {
      if (error instanceof RequestBodyError) {
        return json(error.status, { error: error.message })
      }
      return json(500, {
        error: error instanceof Error ? error.message : "Gateway request failed"
      })
    }
  }
}
