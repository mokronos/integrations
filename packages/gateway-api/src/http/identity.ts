import { Context, Effect, Option, Schema } from "effect"
import { HttpServerResponse } from "effect/http"
import { Forbidden, GatewayFailure, RateLimited, Unauthorized } from "@integragents/contracts"
import type { Profile, ProfileCapability, SubjectId, TenantId } from "@integragents/contracts"
import type { ApiKey, CallOrigin, OAuthActor } from "@integragents/gateway-core/domain"
// By subpath: the API definition is imported by browser clients, and the
// gateway-core index reaches the store.
import { keyOrigin, oauthOrigin, SessionTokenHash } from "@integragents/gateway-core/domain"

export { Forbidden, GatewayFailure, RateLimited, Unauthorized }

/** Why a presented API key was refused: it is unknown or revoked, or its profile is. */
export type KeyRefusal = "unknown-key" | "key-revoked" | "profile-revoked"

export const refusedKey = (refusal: KeyRefusal): Unauthorized | Forbidden =>
  refusal === "profile-revoked" ? new Forbidden({ code: refusal }) : new Unauthorized({ code: refusal })

const encodeRateLimited = Schema.encodeSync(RateLimited)

export const rateLimitedResponse = (retryAfterSeconds: number) =>
  HttpServerResponse.jsonUnsafe(encodeRateLimited(new RateLimited({ retryAfterSeconds })), {
    status: 429,
    headers: { "retry-after": String(retryAfterSeconds) }
  })

export type Access = "public" | "delegated" | "provisioning" | "administrative" | "human"

export const RequiredAccess = Context.Reference<Access>("@integragents/gateway-api/RequiredAccess", {
  defaultValue: (): Access => "public"
})

export const Unmetered = Context.Reference<boolean>("@integragents/gateway-api/Unmetered", {
  defaultValue: (): boolean => false
})

/**
 * Who a request authenticated as: one of a profile's keys, an OAuth grant a
 * person gave a device such as `i`, a dashboard session, or the local host's
 * borrowed key.
 */
export type Principal =
  /** `sessionExpired` when a session cookie came that no longer opens a session. */
  | { readonly kind: "anonymous"; readonly sessionExpired?: boolean }
  | { readonly kind: "key"; readonly profile: Profile; readonly key: ApiKey; readonly secret: string }
  | { readonly kind: "grant"; readonly profile: Profile; readonly actor: OAuthActor }
  | { readonly kind: "local"; readonly profile: Profile; readonly key: ApiKey }
  | {
      readonly kind: "session"
      readonly tenantId: TenantId
      readonly subjectId: SubjectId
      readonly email: string
      readonly tokenHash: SessionTokenHash
    }

export class Identity extends Context.Service<Identity, Principal>()("@integragents/gateway-api/Identity") {}

export interface ProfileCaller {
  readonly profile: Profile
  readonly origin: CallOrigin
  /** The person the credential acts for: the one a key was issued for, or who approved a login. */
  readonly subject: SubjectId | undefined
}

/** The profile a caller acts as, for whom, and how its calls are attributed. */
export const requireProfileCaller: Effect.Effect<ProfileCaller, Forbidden, Identity> = Effect.flatMap(
  Identity,
  (caller): Effect.Effect<ProfileCaller, Forbidden> => {
    switch (caller.kind) {
      case "key":
      case "local":
        return Effect.succeed({
          profile: caller.profile,
          origin: keyOrigin(caller.key),
          subject: caller.key.subjectId ?? undefined
        })
      case "grant":
        return Effect.succeed({
          profile: caller.profile,
          origin: oauthOrigin(caller.actor),
          subject: caller.actor.subjectId
        })
      case "session":
      case "anonymous":
        return Effect.fail(new Forbidden({ code: "not-permitted" }))
    }
  }
)

export const requireTenant: Effect.Effect<TenantId, Forbidden, Identity> = Effect.flatMap(Identity, (caller) => {
  switch (caller.kind) {
    case "key":
    case "local":
    case "grant":
      return Effect.succeed(caller.profile.tenantId)
    case "session":
      return Effect.succeed(caller.tenantId)
    case "anonymous":
      return Effect.fail(new Forbidden({ code: "not-permitted" }))
  }
})

export const currentSession: Effect.Effect<
  Option.Option<{ readonly email: string; readonly subjectId: SubjectId; readonly tokenHash: SessionTokenHash }>,
  never,
  Identity
> = Effect.map(Identity, (caller) => (caller.kind === "session" ? Option.some(caller) : Option.none()))

export const decidedBy: Effect.Effect<string | null, never, Identity> = Effect.map(Identity, (caller) =>
  caller.kind === "session" ? caller.email : caller.kind === "local" ? `local:${caller.profile.name}` : null
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
