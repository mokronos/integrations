import { Context, Effect, Option, Schema } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiSchema } from "effect/unstable/httpapi"
import type { Client, ClientCapability, SubjectId, TenantId } from "@mokronos/gateway-core"
import { SessionTokenHash } from "@mokronos/gateway-core"

/** Who a request is, and what that lets it do.
 *
 *  The gateway's authority model is richer than a bearer scheme: five kinds of
 *  caller against five levels of access, and the interesting rules are the ones
 *  that *deny* — a signed-in human may administer but may never invoke, and a
 *  machine key may invoke but may never decide an approval.
 *
 *  Both halves live here so neither can drift from the other. */

/** Every way a credential can be refused.
 *
 *  Naming the union rather than keying tables by `string` is what makes the
 *  status and sentence tables total: a new refusal cannot be introduced without
 *  also being given both. */
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

/** A refusal states both a sentence and a `code`. Clients branch on the code:
 *  matching on prose is how "not authorized" ends up being explained to a user as
 *  a permissions-tier problem. The two classes exist because the wire speaks in
 *  status codes — unknown and revoked keys are 401, everything else is 403 —
 *  and a single class could only carry one static status annotation. */
export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  "Unauthorized",
  { code: Schema.Literals(["unknown-key", "key-revoked"]), error: Schema.String }
) {
  static readonly of = (code: UnauthorizedReason): Unauthorized =>
    new Unauthorized({ code, error: refusalMessage[code] })
}

/** The wire form: the class plus its status annotation, as endpoints declare
 *  it. Instances of the class encode through this. */
export const UnauthorizedError = Unauthorized.pipe(HttpApiSchema.status(401))

export class Forbidden extends Schema.TaggedError<Forbidden>()(
  "Forbidden",
  { code: Schema.Literals(["client-revoked", "not-permitted", "cross-site"]), error: Schema.String }
) {
  static readonly of = (code: ForbiddenReason): Forbidden =>
    new Forbidden({ code, error: refusalMessage[code] })
}

export const ForbiddenError = Forbidden.pipe(HttpApiSchema.status(403))

/** One refusal, whichever status it becomes. Middleware thinks in these; the
 *  wire decides between {@link Unauthorized} and {@link Forbidden}. */
export type Refused =
  | Unauthorized
  | Forbidden

export const refusedOf = (code: RefusalReason): Refused =>
  code === "unknown-key" || code === "key-revoked"
    ? Unauthorized.of(code)
    : Forbidden.of(code)

/** Too many requests. Never an encoded error: the `retry-after` header is
 *  dynamic, so the middleware answers with a raw response carrying the same
 *  `{error, code}` body the pre-HttpApi surface sent. */
export const rateLimitedResponse = (retryAfterSeconds: number) =>
  HttpServerResponse.jsonUnsafe(
    { error: `Too many requests; retry in ${retryAfterSeconds} seconds`, code: "rate-limited" },
    { status: 429, headers: { "retry-after": String(retryAfterSeconds) } }
  )

/** The authority a route requires.
 *
 *  `delegated` is policy-scoped client work, `provisioning` manages the catalog
 *  and connections, `administrative` changes delegation or inspects the control
 *  plane, and `human` is reserved for decisions an automated client must never
 *  make for itself. */
export type Access =
  | "public"
  | "delegated"
  | "provisioning"
  | "administrative"
  | "human"

/** The access an endpoint requires, carried as an annotation so one middleware
 *  can enforce every route without a table to keep in step. An endpoint that
 *  declares nothing is `public`, which is the only safe default that is also
 *  never silently wrong: a forgotten annotation on a protected route fails
 *  visibly in tests rather than quietly authorizing access, because its handler
 *  will find no identity to work with. */
export const RequiredAccess = Context.Reference<Access>(
  "@mokronos/integrations/RequiredAccess",
  { defaultValue: (): Access => "public" }
)

/** Marks the handful of endpoints that answer before any metering — health
 *  and metadata are what the monitor polls while everything else is drowning,
 *  so they can never spend a rate bucket, and tracing them only fills the
 *  backend with liveness noise. Absent means metered like everything else. */
export const Unmetered = Context.Reference<boolean>(
  "@mokronos/integrations/Unmetered",
  { defaultValue: (): boolean => false }
)

/** An authenticated caller, as the handlers see it.
 *
 *  `local` is ambient authority available only to the same-origin control plane
 *  on a loopback deployment; it is not constructible from an HTTP credential. */
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

/** The caller behind the request being handled. Provided by the authority
 *  middleware, so a handler cannot run without one having been decided. */
export class Identity extends Context.Service<Identity, Caller>()(
  "@mokronos/integrations/Identity"
) {}

/** The client behind this request.
 *
 *  A handler on a `delegated` route may assert this; reaching it from a route
 *  that admits sessions is a bug, and fails loudly rather than authorizing
 *  nobody. */
export const requireClient: Effect.Effect<Client, Forbidden, Identity> = Effect.flatMap(
  Identity,
  (caller) =>
    caller.kind === "client" || caller.kind === "local"
      ? Effect.succeed(caller.client)
      : Effect.fail(Forbidden.of("not-permitted"))
)

/** The presented API key. Only meaningful alongside {@link requireClient}. */
export const requireSecret: Effect.Effect<string, Unauthorized | Forbidden, Identity> = Effect.gen(
  function* () {
    const caller = yield* Identity
    if (caller.kind === "client") return caller.secret
    if (caller.kind === "local") return yield* Forbidden.of("not-permitted")
    return yield* Unauthorized.of("unknown-key")
  }
)

/** The tenant this request acts within: the client's partition, or the
 *  signed-in human's. Every tenant-scoped read goes through here, so a session
 *  and a key see the same slice of the world. */
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

/** The signed-in human behind this request, if there is one. Used for display
 *  and attribution — `decidedBy` on an approval — never for authority. */
export const currentSession: Effect.Effect<
  Option.Option<{ readonly email: string; readonly subjectId: SubjectId; readonly tokenHash: SessionTokenHash }>,
  never,
  Identity
> = Effect.map(
  Identity,
  (caller) => caller.kind === "session" ? Option.some(caller) : Option.none()
)

/** Who signed a decision, for the audit line: the human's email, or the local
 *  control plane speaking for the operator at the keyboard. */
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

/** The capability a route's access level demands of a machine caller, or
 *  `undefined` where holding a live key is itself sufficient. */
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
