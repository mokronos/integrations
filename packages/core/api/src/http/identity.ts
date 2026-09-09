import { Context, Effect, Option, Schema } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiSchema } from "effect/unstable/httpapi"
import { RefusalReason, refusalReason } from "@integrations/contracts"
import type { Client, ClientCapability, SubjectId, TenantId } from "@integrations/contracts"
// By subpath: the API definition is imported by browser clients, and the
// gateway-core index reaches the store.
import { SessionTokenHash } from "@integrations/gateway-core/domain"

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
  { code: Schema.Literals(["client-revoked", "not-permitted", "cross-site"]), message: Schema.String }
) {
  static readonly of = (code: ForbiddenReason["code"]): Forbidden => {
    return new Forbidden({ code, message: refusalReason(code).message })
  }
}

export const ForbiddenError = Forbidden.pipe(HttpApiSchema.status(403))

export const Refused = Schema.Union([Unauthorized, Forbidden])
export type Refused = typeof Refused.Type

export const refusedOf = (code: RefusalReason["code"]): Refused =>
  code === "unknown-key" || code === "key-revoked"
    ? Unauthorized.of(code)
    : Forbidden.of(code)

export const rateLimitedResponse = (retryAfterSeconds: number) =>
  HttpServerResponse.jsonUnsafe(
    { error: `Too many requests; retry in ${retryAfterSeconds} seconds`, code: "rate-limited" },
    { status: 429, headers: { "retry-after": String(retryAfterSeconds) } }
  )

export type Access =
  | "public"
  | "delegated"
  | "provisioning"
  | "administrative"
  | "human"

export const RequiredAccess = Context.Reference<Access>(
  "@integrations/host/RequiredAccess",
  { defaultValue: (): Access => "public" }
)

export const Unmetered = Context.Reference<boolean>(
  "@integrations/host/Unmetered",
  { defaultValue: (): boolean => false }
)

export type Caller =
  | { readonly kind: "anonymous" }
  | { readonly kind: "client"; readonly client: Client; readonly secret: string }
  | { readonly kind: "local"; readonly client: Client }
  | {
    readonly kind: "session"
    readonly tenantId: TenantId
    readonly subjectId: SubjectId
    readonly email: string
    readonly tokenHash: SessionTokenHash
  }

export class Identity extends Context.Service<Identity, Caller>()(
  "@integrations/host/Identity"
) {}

export const requireClient: Effect.Effect<Client, Forbidden, Identity> = Effect.flatMap(
  Identity,
  (caller) =>
    caller.kind === "client" || caller.kind === "local"
      ? Effect.succeed(caller.client)
      : Effect.fail(Forbidden.of("not-permitted"))
)

export const requireSecret: Effect.Effect<string, Unauthorized | Forbidden, Identity> = Effect.gen(
  function* () {
    const caller = yield* Identity
    if (caller.kind === "client") return caller.secret
    if (caller.kind === "local") return yield* Forbidden.of("not-permitted")
    return yield* Unauthorized.of("unknown-key")
  }
)

export const requireTenant: Effect.Effect<TenantId, Forbidden, Identity> = Effect.flatMap(
  Identity,
  (caller) => {
    switch (caller.kind) {
      case "client":
      case "local":
        return Effect.succeed(caller.client.tenantId)
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
      ? `local:${caller.client.name}`
      : null
)

export const requiredCapability = (access: Access): ClientCapability | undefined => {
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
