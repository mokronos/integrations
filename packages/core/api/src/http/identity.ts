import { Context, Effect, Option, Schema } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiSchema } from "effect/unstable/httpapi"
import type { Client, ClientCapability, SubjectId, TenantId } from "@mokronos/gateway-core"
import { SessionTokenHash } from "@mokronos/gateway-core"

export const RefusalReason = Schema.Literals([
  "unknown-key",
  "key-revoked",
  "client-revoked",
  "not-permitted",
  "cross-site"
])
export type RefusalReason = typeof RefusalReason.Type

const refusalMessage = {
  "unknown-key": "This API key is not known to the gateway",
  "key-revoked": "This API key was revoked",
  "client-revoked": "The client this key belongs to was revoked",
  "not-permitted": "This credential does not hold the capability required by this route",
  "cross-site": "Cross-site requests are not permitted"
} satisfies Record<RefusalReason, string>

type UnauthorizedReason = Extract<RefusalReason, "unknown-key" | "key-revoked">
type ForbiddenReason = Exclude<RefusalReason, UnauthorizedReason>

export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  "Unauthorized",
  { code: Schema.Literals(["unknown-key", "key-revoked"]), error: Schema.String }
) {
  static readonly of = (code: UnauthorizedReason): Unauthorized =>
    new Unauthorized({ code, error: refusalMessage[code] })
}

export const UnauthorizedError = Unauthorized.pipe(HttpApiSchema.status(401))

export class Forbidden extends Schema.TaggedError<Forbidden>()(
  "Forbidden",
  { code: Schema.Literals(["client-revoked", "not-permitted", "cross-site"]), error: Schema.String }
) {
  static readonly of = (code: ForbiddenReason): Forbidden =>
    new Forbidden({ code, error: refusalMessage[code] })
}

export const ForbiddenError = Forbidden.pipe(HttpApiSchema.status(403))

export type Refused =
  | Unauthorized
  | Forbidden

export const refusedOf = (code: RefusalReason): Refused =>
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
  "@mokronos/integrations/RequiredAccess",
  { defaultValue: (): Access => "public" }
)

export const Unmetered = Context.Reference<boolean>(
  "@mokronos/integrations/Unmetered",
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
  "@mokronos/integrations/Identity"
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
