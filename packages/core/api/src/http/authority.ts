import { Context, Duration, Effect, Layer, Option } from "effect"
import { RateLimiter } from "effect/unstable/persistence"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { HttpEffect, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { authenticateClient, authorizeClientCapability } from "@mokronos/gateway-core"
import { SessionTokenHash } from "@mokronos/gateway-core"
import { hashSessionToken } from "@mokronos/gateway-core"
import type { GatewayStore } from "@mokronos/gateway-core"
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
import { capture } from "./observability.ts"
export type { Caller, Refused } from "./identity.ts"

const sessionCookieName = "wf_session"

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

export interface RequestContext {
  readonly localSecret?: string
  readonly remoteAddress?: string
}

export const CurrentRequestContext = Context.Reference<RequestContext>(
  "@mokronos/integrations/RequestContext",
  { defaultValue: (): RequestContext => ({}) }
)

export interface RateLimits {
  readonly addressPerMinute: number
  readonly principalPerMinute: number
}

export interface AuthorityOptions {
  readonly store: GatewayStore
  readonly rateLimits?: RateLimits
}

const resolveCaller = Effect.fn("authority.resolveCaller")(function*(
  options: AuthorityOptions,
  headers: Readonly<Record<string, string>>,
  context: RequestContext
) {
  const secret = presentedSecret(headers)
  if (Option.isSome(secret)) {
    const authentication = yield* capture(authenticateClient(options.store, secret.value)
    )
    if (authentication.status !== "authenticated") {
      return yield* refusedOf(authentication.status)
    }
    return { kind: "client", client: authentication.client, secret: secret.value } satisfies Caller
  }

  const token = readSessionCookieValue(headers["cookie"])
  if (Option.isSome(token)) {
    const session = yield* capture(
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
    const authentication = yield* capture(authenticateClient(options.store, localSecret)
    )
    if (authentication.status === "authenticated") {
      return { kind: "local", client: authentication.client } satisfies Caller
    }
  }

  return { kind: "anonymous" } satisfies Caller
})

const admit = Effect.fn("authority.admit")(function*(
  options: AuthorityOptions,
  caller: Caller,
  access: Access,
  method: string,
  headers: Readonly<Record<string, string>>
) {
  if (caller.kind === "session" && method !== "GET" && !sameOrigin(headers)) {
    return yield* Forbidden.of("cross-site")
  }

  if (access === "public") return

  if (caller.kind === "session" || caller.kind === "local") {
    if (access === "delegated") {
      return yield* Forbidden.of("not-permitted")
    }
    return
  }

  if (caller.kind === "anonymous") {
    return yield* new Unauthorized({
      code: "unknown-key",
      error: "An API key is required"
    })
  }

  if (access === "human") return yield* Forbidden.of("not-permitted")

  const capability = requiredCapability(access)
  if (capability === undefined) return
  const authorization = yield* capture(authorizeClientCapability(options.store, caller.secret, capability)
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

const rateLimitWindow = Duration.minutes(1)

const refusalOf = (
  error: RateLimiter.RateLimiterError
): Effect.Effect<Option.Option<HttpServerResponse.HttpServerResponse>> =>
  error.reason._tag === "RateLimitExceeded"
    ? Effect.succeed(Option.some(rateLimitedResponse(
      Math.max(1, Math.ceil(Duration.toMillis(error.reason.retryAfter) / 1_000))
    )))
    : Effect.die(error)

export class Authority extends HttpApiMiddleware.Service<Authority, {
  provides: Identity
}>()("@mokronos/integrations/Authority", {
  error: [UnauthorizedError, ForbiddenError]
}) {
  static readonly layer = (options: AuthorityOptions): Layer.Layer<Authority> =>
    Layer.effect(
      Authority,
      Effect.gen(function*() {
        const limits = options.rateLimits
        const limiter = yield* RateLimiter.RateLimiter
        const meter = (key: string, limit: number) =>
          limiter.consume({ key, limit, window: rateLimitWindow }).pipe(
            Effect.as(Option.none<HttpServerResponse.HttpServerResponse>()),
            Effect.catch(refusalOf)
          )

        return (httpEffect, { endpoint }) =>
          Effect.gen(function*() {
            const request = yield* HttpServerRequest.HttpServerRequest
            const context = yield* CurrentRequestContext
            const headers = request.headers
            const unmetered = Context.get(endpoint.annotations, Unmetered)

            if (!unmetered && limits !== undefined) {
              const refused = yield* meter(
                `addr:${context.remoteAddress ?? "unknown"}`,
                limits.addressPerMinute
              )
              if (Option.isSome(refused)) return refused.value
            }

            const caller = unmetered
              ? ({ kind: "anonymous" } satisfies Caller)
              : yield* resolveCaller(options, headers, context)

            if (!unmetered && limits !== undefined) {
              const key = principalKey(caller)
              if (Option.isSome(key)) {
                const refused = yield* meter(key.value, limits.principalPerMinute)
                if (Option.isSome(refused)) return refused.value
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
      })
    ).pipe(
      Layer.provide(RateLimiter.layer.pipe(Layer.provide(RateLimiter.layerStoreMemory)))
    )
}
