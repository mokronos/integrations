import { Context, Duration, Effect, Layer, Option } from "effect"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { HttpEffect, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { authenticateClient, authorizeClientCapability } from "../authorize.ts"
import { SessionTokenHash } from "../domain.ts"
import { hashSessionToken } from "../passwords.ts"
import type { RateLimiter } from "../ratelimit.ts"
import type { GatewayStore } from "../store.ts"
import { GatewayStoreError } from "../store.ts"
import {
  Identity,
  Forbidden,
  ForbiddenError,
  RequiredAccess,
  Unauthorized,
  UnauthorizedError,
  Unmetered,
  rateLimitedResponse,
  refusedOf,
  requiredCapability
} from "./identity.ts"
import type { Access, Caller } from "./identity.ts"

export {
  currentSession,
  decidedBy,
  Forbidden,
  Identity,
  requireClient,
  requireSecret,
  requireTenant,
  Unauthorized
} from "./identity.ts"
export type { Caller, Refused } from "./identity.ts"

/** Deciding who a request is, and whether that is enough for the route it is
 *  headed for.
 *
 *  This runs as middleware rather than inside handlers for one reason: a new
 *  endpoint cannot forget to check. Access is declared on the endpoint as an
 *  annotation and enforced here, so the only way to expose something is to say
 *  so. */

const sessionCookieName = "wf_session"

const orDieStorage = <A, E, R>(effect: Effect.Effect<A, E | GatewayStoreError, R>) =>
  effect.pipe(Effect.catchTag("GatewayStoreError", Effect.die))

/** Reads one cookie out of the `Cookie` header, if present. */
export const readSessionCookieValue = (header: string | undefined): Option.Option<string> => {
  if (header === undefined) return Option.none()
  for (const part of header.split(";")) {
    const equals = part.indexOf("=")
    if (equals === -1) continue
    if (part.slice(0, equals).trim() === sessionCookieName) {
      const value = part.slice(equals + 1).trim()
      return value.length === 0 ? Option.none() : Option.some(value)
    }
  }
  return Option.none()
}

/** `HttpOnly` so script cannot read it, `SameSite=Lax` so another origin cannot
 *  spend it on a state-changing request, `Secure` wherever TLS is actually in
 *  play. */
const sessionCookieOptions = (options: {
  readonly maxAgeSeconds: number
  readonly secure: boolean
}) => ({
  path: "/",
  httpOnly: true,
  sameSite: "lax",
  secure: options.secure,
  maxAge: Duration.seconds(options.maxAgeSeconds)
} as const)

/** Attaches the session cookie to whatever response the handler produces.
 *
 *  Setting it here rather than building a response by hand is what lets a
 *  handler return its declared success value: a typed endpoint should not have
 *  to drop to a raw response merely to carry one header. It works the same for
 *  the OAuth flow's HTML pages and redirects, which are raw for their own
 *  reasons. */
export const setSessionCookie = (token: string, options: {
  readonly maxAgeSeconds: number
  readonly secure: boolean
}): Effect.Effect<void, never, HttpServerRequest.HttpServerRequest> =>
  HttpEffect.appendPreResponseHandler((_request, response) =>
    Effect.succeed(HttpServerResponse.setCookieUnsafe(
      response,
      sessionCookieName,
      token,
      sessionCookieOptions(options)
    )))

/** Expires the session cookie. The empty value is incidental; `Max-Age=0` is
 *  what removes it. */
export const clearSessionCookie = (
  options: { readonly secure: boolean }
): Effect.Effect<void, never, HttpServerRequest.HttpServerRequest> =>
  HttpEffect.appendPreResponseHandler((_request, response) =>
    Effect.succeed(HttpServerResponse.setCookieUnsafe(
      response,
      sessionCookieName,
      "",
      sessionCookieOptions({ maxAgeSeconds: 0, secure: options.secure })
    )))

/** `Authorization: Bearer <key>`, or the `x-api-key` header. Nothing reads a key
 *  from the query string, where it would land in access logs. */
const presentedSecret = (
  headers: Readonly<Record<string, string>>
): Option.Option<string> => {
  const authorization = headers["authorization"]
  if (authorization !== undefined) {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim())
    if (match?.[1] !== undefined) return Option.some(match[1])
  }
  const apiKey = headers["x-api-key"]
  return apiKey === undefined || apiKey.length === 0 ? Option.none() : Option.some(apiKey)
}

/** Cookie-carried credentials need the browser's own attestation that this
 *  request came from our origin; that is what stops another site from making the
 *  browser spend the session. A key in a header needs nothing here — cross-site
 *  script cannot read it out of another origin's storage to begin with. */
const sameOrigin = (headers: Readonly<Record<string, string>>): boolean => {
  const fetchSite = headers["sec-fetch-site"]?.trim().toLowerCase()
  if (fetchSite === "same-origin" || fetchSite === "none") return true
  const origin = headers["origin"]
  const host = headers["host"]
  if (origin === undefined || host === undefined) return false
  return Option.match(
    Option.liftThrowable(() => new URL(origin).host)(),
    {
      onNone: () => false,
      onSome: (originHost) => originHost === host.trim().toLowerCase()
    }
  )
}

/** What the server knows about a request that the request itself cannot say.
 *
 *  `localSecret` is the local client's key, and is set only by a server that has
 *  already decided this request may borrow it — see `http/loopback.ts`. Nothing
 *  here re-derives that decision, so a caller cannot reach it by setting a
 *  header. `remoteAddress` feeds the pre-authentication rate bucket. */
export interface RequestContext {
  readonly localSecret?: string
  readonly remoteAddress?: string
}

/** Per-request server knowledge, provided by whatever accepted the socket: the
 *  web-handler seam carries it in the per-request context, and the served
 *  gateway derives it straight from the platform request. */
export const CurrentRequestContext = Context.Reference<RequestContext>(
  "@mokronos/integrations/RequestContext",
  { defaultValue: (): RequestContext => ({}) }
)

export interface AuthorityOptions {
  readonly store: GatewayStore
  /** Two buckets with distinct key spaces: a per-address limit before
   *  authentication protects the credential machinery itself, and a
   *  per-principal limit after it keeps one misbehaving client from starving
   *  its neighbours. */
  readonly addressRateLimiter?: RateLimiter
  readonly rateLimiter?: RateLimiter
}

/** Decides who a request is, from at most one credential source.
 *
 *  Precedence is by trust, not by header order: an explicitly presented key
 *  always speaks for itself; the session cookie is consulted only when no key
 *  was presented, since a dashboard page holds a cookie and never a key; the
 *  borrowed local credential is last, and only arrives pre-approved. Anything
 *  presented but not accepted refuses with *why*. */
const resolveCaller = Effect.fn("authority.resolveCaller")(function*(
  options: AuthorityOptions,
  headers: Readonly<Record<string, string>>,
  context: RequestContext
) {
  const secret = presentedSecret(headers)
  if (Option.isSome(secret)) {
    const authentication = yield* orDieStorage(authenticateClient(options.store, secret.value)
    )
    if (authentication.status !== "authenticated") {
      return yield* refusedOf(authentication.status)
    }
    return { kind: "client", client: authentication.client, secret: secret.value } satisfies Caller
  }

  const token = readSessionCookieValue(headers["cookie"])
  if (Option.isSome(token)) {
    const session = yield* orDieStorage(
      options.store.findLiveSession(SessionTokenHash.make(hashSessionToken(token.value)))
    )
    if (session === undefined) return { kind: "anonymous" } satisfies Caller
    return {
      kind: "session",
      tenantId: session.tenantId,
      subjectId: session.subjectId,
      email: session.email,
      tokenHash: session.tokenHash
    } satisfies Caller
  }

  const localSecret = context.localSecret
  if (localSecret !== undefined) {
    const authentication = yield* orDieStorage(authenticateClient(options.store, localSecret)
    )
    if (authentication.status === "authenticated") {
      return { kind: "local", client: authentication.client } satisfies Caller
    }
  }

  return { kind: "anonymous" } satisfies Caller
})

/** Whether this caller may reach a route with this access level. */
const admit = Effect.fn("authority.admit")(function*(
  options: AuthorityOptions,
  caller: Caller,
  access: Access,
  method: string,
  headers: Readonly<Record<string, string>>
) {
  // A session riding a cookie must prove same-origin for anything but a read,
  // whatever route it is headed for.
  if (caller.kind === "session" && method !== "GET" && !sameOrigin(headers)) {
    return yield* Forbidden.of("cross-site")
  }

  // Public routes decide for themselves what an absent identity means; the
  // login surface cannot require the credential it creates.
  if (access === "public") return

  // Human sessions and the ambient local control plane may administer, but
  // neither may invoke through delegated aliases. Issuing a client key is what
  // turns human authority into a deliberately bounded machine caller.
  if (caller.kind === "session" || caller.kind === "local") {
    if (access === "delegated") {
      return yield* Forbidden.of("not-permitted")
    }
    return
  }

  if (caller.kind === "anonymous") {
    // Absent rather than rejected: there is nothing to explain about a
    // credential that was never presented.
    return yield* new Unauthorized({
      code: "unknown-key",
      error: "An API key is required"
    })
  }

  // A decision a human must make for themselves is one an automated client
  // must never make for itself.
  if (access === "human") return yield* Forbidden.of("not-permitted")

  const capability = requiredCapability(access)
  if (capability === undefined) return
  const authorization = yield* orDieStorage(authorizeClientCapability(options.store, caller.secret, capability)
  )
  if (authorization.status !== "authorized") {
    return yield* refusedOf(authorization.status)
  }
})

const principalKey = (caller: Caller): Option.Option<string> => {
  switch (caller.kind) {
    case "session":
      return Option.some(`subject:${caller.subjectId}`)
    case "client":
    case "local":
      return Option.some(`${caller.kind}:${caller.client.id}`)
    case "anonymous":
      return Option.none()
  }
}

/** The gateway's authority check, as `HttpApi` middleware. Provides
 *  {@link Identity} to every handler that runs. */
export class Authority extends HttpApiMiddleware.Service<Authority, {
  provides: Identity
}>()("@mokronos/integrations/Authority", {
  error: [UnauthorizedError, ForbiddenError]
}) {
  static readonly layer = (options: AuthorityOptions): Layer.Layer<Authority> =>
    Layer.effect(
      Authority,
      Effect.sync(() => (httpEffect, { endpoint }) =>
        Effect.gen(function*() {
          const request = yield* HttpServerRequest.HttpServerRequest
          const context = yield* CurrentRequestContext
          const headers = request.headers
          const unmetered = Context.get(endpoint.annotations, Unmetered)

          if (!unmetered && options.addressRateLimiter !== undefined) {
            // Before authentication, so guessing credentials costs a bucket
            // slot per attempt rather than a key lookup.
            const verdict = options.addressRateLimiter.take(
              `addr:${context.remoteAddress ?? "unknown"}`
            )
            if (!verdict.allowed) {
              return rateLimitedResponse(verdict.retryAfterSeconds)
            }
          }

          const caller = unmetered
            ? ({ kind: "anonymous" } satisfies Caller)
            : yield* resolveCaller(options, headers, context)

          if (!unmetered && options.rateLimiter !== undefined) {
            const key = principalKey(caller)
            if (Option.isSome(key)) {
              const verdict = options.rateLimiter.take(key.value)
              if (!verdict.allowed) {
                return rateLimitedResponse(verdict.retryAfterSeconds)
              }
            }
          }

          if (!unmetered) {
            const access = Context.getOrElse(
              endpoint.annotations,
              RequiredAccess,
              () => RequiredAccess.defaultValue()
            )
            yield* admit(options, caller, access, request.method, headers)
          }

          return yield* Effect.provideService(httpEffect, Identity, caller)
        })
      )
    )
}
