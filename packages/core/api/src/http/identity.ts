import { Context, Effect, Option, Schema } from "effect"
import { HttpServerResponse } from "effect/http"
import { HttpApiSchema } from "effect/http-api"
import { RefusalReason, refusalReason } from "@integragents/contracts"
import type { Profile, ProfileCapability, SubjectId, TenantId } from "@integragents/contracts"
import type { ApiKey } from "@integragents/gateway-core/domain"
// By subpath: the API definition is imported by browser clients, and the
// gateway-core index reaches the store.
import { SessionTokenHash } from "@integragents/gateway-core/domain"

type UnauthorizedReason = Extract<RefusalReason, { readonly code: "unknown-key" | "key-revoked" }>
type ForbiddenReason = Exclude<RefusalReason, UnauthorizedReason>

export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  "Unauthorized",
  { code: Schema.Literals(["unknown-key", "key-revoked"]), message: Schema.String }
) {
  static readonly of = (code: UnauthorizedReason["code"]): Unauthorized => {
    return new Unauthorized({ code, message: refusalReason(code).message })
  }
}

export const UnauthorizedError = Unauthorized.pipe(HttpApiSchema.status(401))

export class Forbidden extends Schema.TaggedError<Forbidden>()(
  "Forbidden",
  { code: Schema.Literals(["profile-revoked", "not-permitted", "cross-site"]), message: Schema.String }
) {
  static readonly of = (code: ForbiddenReason["code"]): Forbidden => {
    return new Forbidden({ code, message: refusalReason(code).message })
  }
}

export const ForbiddenError = Forbidden.pipe(HttpApiSchema.status(403))

/** A request the gateway could not complete; the trace id finds its spans and logs. */
export class GatewayFailure extends Schema.TaggedError<GatewayFailure>()(
  "GatewayFailure",
  { message: Schema.String, traceId: Schema.String }
) {}

export const GatewayFailureError = GatewayFailure.pipe(HttpApiSchema.status(500))

export const Refused = Schema.Union([Unauthorized, Forbidden])
export type Refused = typeof Refused.Type

export const refusedOf = (code: RefusalReason["code"]): Refused =>
  code === "unknown-key" || code === "key-revoked"
    ? Unauthorized.of(code)
    : Forbidden.of(code)

export class RateLimited extends Schema.TaggedError<RateLimited>()(
  "RateLimited",
  { code: Schema.Literal("rate-limited"), message: Schema.String }
) {}

export const RateLimitedError = RateLimited.pipe(HttpApiSchema.status(429))

const encodeRateLimited = Schema.encodeSync(RateLimited)

export const rateLimitedResponse = (retryAfterSeconds: number) =>
  HttpServerResponse.jsonUnsafe(
    encodeRateLimited(new RateLimited({
      code: "rate-limited",
      message: `Too many requests; retry in ${retryAfterSeconds} seconds`
    })),
    { status: 429, headers: { "retry-after": String(retryAfterSeconds) } }
  )

export type Access =
  | "public"
  | "delegated"
  | "provisioning"
  | "administrative"
  | "human"

export const RequiredAccess = Context.Reference<Access>(
  "@integragents/gateway-api/RequiredAccess",
  { defaultValue: (): Access => "public" }
)

export const Unmetered = Context.Reference<boolean>(
  "@integragents/gateway-api/Unmetered",
  { defaultValue: (): boolean => false }
)

/** Who a request authenticated as: one of a profile's keys, a dashboard session, or the local host's borrowed key. */
export type Principal =
  | { readonly kind: "anonymous" }
  | { readonly kind: "key"; readonly profile: Profile; readonly key: ApiKey; readonly secret: string }
  | { readonly kind: "local"; readonly profile: Profile; readonly key: ApiKey }
  | {
    readonly kind: "session"
    readonly tenantId: TenantId
    readonly subjectId: SubjectId
    readonly email: string
    readonly tokenHash: SessionTokenHash
  }

export class Identity extends Context.Service<Identity, Principal>()(
  "@integragents/gateway-api/Identity"
) {}

export const requireKeyHolder: Effect.Effect<{ readonly profile: Profile; readonly key: ApiKey }, Forbidden, Identity> = Effect.flatMap(
  Identity,
  (caller) =>
    caller.kind === "key" || caller.kind === "local"
      ? Effect.succeed(caller)
      : Effect.fail(Forbidden.of("not-permitted"))
)

export const requireSecret: Effect.Effect<string, Unauthorized | Forbidden, Identity> = Effect.gen(
  function* () {
    const caller = yield* Identity
    if (caller.kind === "key") return caller.secret
    if (caller.kind === "local") return yield* Forbidden.of("not-permitted")
    return yield* Unauthorized.of("unknown-key")
  }
)

export const requireTenant: Effect.Effect<TenantId, Forbidden, Identity> = Effect.flatMap(
  Identity,
  (caller) => {
    switch (caller.kind) {
      case "key":
      case "local":
        return Effect.succeed(caller.profile.tenantId)
      case "session":
        return Effect.succeed(caller.tenantId)
      case "anonymous":
        return Effect.fail(Forbidden.of("not-permitted"))
    }
  }
)

export const currentSession: Effect.Effect<
  Option.Option<{ readonly email: string; readonly subjectId: SubjectId; readonly tokenHash: SessionTokenHash }>,
  never,
  Identity
> = Effect.map(
  Identity,
  (caller) => caller.kind === "session" ? Option.some(caller) : Option.none()
)

export const decidedBy: Effect.Effect<
  string | null,
  never,
  Identity
> = Effect.map(
  Identity,
  (caller) =>
    caller.kind === "session"
      ? caller.email
      : caller.kind === "local"
      ? `local:${caller.profile.name}`
      : null
)

export const requiredCapability = (access: Access): ProfileCapability | undefined => {
  switch (access) {
    case "provisioning":
      return "provision_connections"
    case "administrative":
      return "administer_gateway"
    case "public":
    case "delegated":
    case "human":
      return undefined
  }
}
