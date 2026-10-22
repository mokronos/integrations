import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api"
import { ProfileCapability, ProfileId, SubjectId } from "@integragents/contracts"
import { Authority } from "../middleware.ts"
import { ForbiddenError, RequiredAccess } from "../identity.ts"
import { ApiBadRequestError } from "./shared.ts"

const Email = Schema.String.check(Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/))

export const SignupBody = Schema.Struct({
  email: Email,
  password: Schema.String.check(Schema.isMinLength(8)),
  tenantName: Schema.optional(Schema.String)
})

export const LoginBody = Schema.Struct({
  email: Email,
  password: Schema.String
})

export const ChangeEmailBody = Schema.Struct({
  email: Email,
  password: Schema.String
})

export const ChangePasswordBody = Schema.Struct({
  currentPassword: Schema.optional(Schema.String),
  newPassword: Schema.String.check(Schema.isMinLength(8))
})

export const DeleteAccountBody = Schema.Struct({
  password: Schema.optional(Schema.String)
})

export class ApiNotImplemented extends Schema.TaggedError<ApiNotImplemented>()("ApiNotImplemented", {
  error: Schema.String,
  code: Schema.String
}) {}
const ApiNotImplementedError = ApiNotImplemented.pipe(HttpApiSchema.status(501))

export class SignupClosed extends Schema.TaggedError<SignupClosed>()("SignupClosed", {
  error: Schema.String,
  code: Schema.Literal("signup-closed")
}) {}
const SignupClosedError = SignupClosed.pipe(HttpApiSchema.status(403))

export class InvalidCredentials extends Schema.TaggedError<InvalidCredentials>()("InvalidCredentials", {
  error: Schema.String,
  code: Schema.Literal("invalid-credentials")
}) {}
const InvalidCredentialsError = InvalidCredentials.pipe(HttpApiSchema.status(401))

export class PasswordRequired extends Schema.TaggedError<PasswordRequired>()("PasswordRequired", {
  error: Schema.String,
  code: Schema.Literal("password-required")
}) {}
const PasswordRequiredError = PasswordRequired.pipe(HttpApiSchema.status(409))

export class HandoffUnknown extends Schema.TaggedError<HandoffUnknown>()("HandoffUnknown", {
  error: Schema.String,
  code: Schema.Literal("login-handoff-unknown")
}) {}
const HandoffUnknownError = HandoffUnknown.pipe(HttpApiSchema.status(404))

export class HandoffExpired extends Schema.TaggedError<HandoffExpired>()("HandoffExpired", {
  error: Schema.String,
  code: Schema.Literal("login-handoff-expired")
}) {}
const HandoffExpiredError = HandoffExpired.pipe(HttpApiSchema.status(410))

export class HandoffCollected extends Schema.TaggedError<HandoffCollected>()("HandoffCollected", {
  error: Schema.String,
  code: Schema.Literal("login-handoff-collected")
}) {}
const HandoffCollectedError = HandoffCollected.pipe(HttpApiSchema.status(410))

const HandoffRaceError = HandoffCollected.pipe(HttpApiSchema.status(409))

const ProvidersView = Schema.Struct({
  signupOpen: Schema.Boolean,
  google: Schema.Union([
    Schema.Struct({ enabled: Schema.Literal(false) }),
    Schema.Struct({
      enabled: Schema.Literal(true),
      startUrl: Schema.String,
      callbackUrl: Schema.String
    })
  ])
})

const CliStartView = Schema.Struct({
  requestId: Schema.String,
  authorizationUrl: Schema.String,
  expiresAt: Schema.Date,
  intervalMs: Schema.Number
})

const CliPollView = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("pending"),
    expiresAt: Schema.Date
  }),
  Schema.Struct({
    status: Schema.Literal("authenticated"),
    token: Schema.String,
    email: Schema.String
  })
])

const MeView = Schema.Union([
  Schema.Struct({
    authenticated: Schema.Literal(true),
    kind: Schema.Literal("session"),
    email: Schema.String,
    tenantId: Schema.String,
    subjectId: SubjectId,
    hasPassword: Schema.Boolean,
    identityProviders: Schema.Array(Schema.String)
  }),
  Schema.Struct({
    authenticated: Schema.Literal(true),
    kind: Schema.Literal("profile"),
    profileId: ProfileId,
    tenantId: Schema.String,
    capabilities: Schema.Array(ProfileCapability)
  }),
  Schema.Struct({
    authenticated: Schema.Literal(true),
    kind: Schema.Literal("local"),
    profileId: ProfileId,
    tenantId: Schema.String
  }),
  Schema.Struct({ authenticated: Schema.Literal(false) })
])

export const AuthGroup = HttpApiGroup.make("auth")
  .add(
    HttpApiEndpoint.get("providers", "/v1/auth/providers", {
      success: ProvidersView
    }).annotate(RequiredAccess, "public")
  )
  .add(
    HttpApiEndpoint.post("cliStart", "/v1/auth/cli/start", {
      success: HttpApiSchema.status(201)(CliStartView),
      error: ApiNotImplementedError
    }).annotate(RequiredAccess, "public")
  )
  .add(
    HttpApiEndpoint.get("cliPoll", "/v1/auth/cli/:id", {
      params: { id: Schema.String },
      success: CliPollView,
      error: [HandoffUnknownError, HandoffExpiredError, HandoffCollectedError, HandoffRaceError]
    }).annotate(RequiredAccess, "public")
  )
  .add(
    HttpApiEndpoint.get("googleStart", "/v1/auth/google/start", {
      query: {
        handoff: Schema.optional(Schema.String),
        returnTo: Schema.optional(Schema.String)
      },
      success: Schema.Struct({ redirected: Schema.Literal(true) })
    }).annotate(RequiredAccess, "public")
  )
  .add(
    HttpApiEndpoint.get("googleCallback", "/v1/auth/google/callback", {
      query: {
        state: Schema.optional(Schema.String),
        code: Schema.optional(Schema.String)
      },
      success: Schema.Struct({ rendered: Schema.Literal(true) })
    }).annotate(RequiredAccess, "public")
  )
  .add(
    HttpApiEndpoint.post("signup", "/v1/auth/signup", {
      payload: SignupBody,
      success: HttpApiSchema.status(201)(
        Schema.Struct({
          tenant: Schema.Struct({ id: Schema.String, name: Schema.String }),
          subjectId: SubjectId,
          email: Schema.String
        })
      ),
      error: [SignupClosedError, ApiBadRequestError]
    }).annotate(RequiredAccess, "public")
  )
  .add(
    HttpApiEndpoint.post("login", "/v1/auth/login", {
      payload: LoginBody,
      success: Schema.Struct({ email: Schema.String, subjectId: SubjectId }),
      error: InvalidCredentialsError
    }).annotate(RequiredAccess, "public")
  )
  .add(
    HttpApiEndpoint.post("logout", "/v1/auth/logout", {
      success: Schema.Struct({ loggedOut: Schema.Literal(true) })
    }).annotate(RequiredAccess, "public")
  )
  .add(
    HttpApiEndpoint.get("whoami", "/v1/auth/me", {
      success: MeView
    }).annotate(RequiredAccess, "public")
  )
  .add(
    HttpApiEndpoint.post("changeEmail", "/v1/auth/email", {
      payload: ChangeEmailBody,
      success: Schema.Struct({ email: Schema.String }),
      error: [ForbiddenError, ApiBadRequestError, InvalidCredentialsError]
    }).annotate(RequiredAccess, "human")
  )
  .add(
    HttpApiEndpoint.post("changePassword", "/v1/auth/password", {
      payload: ChangePasswordBody,
      success: Schema.Struct({
        updated: Schema.Literal(true),
        revokedSessions: Schema.Number
      }),
      error: [ForbiddenError, InvalidCredentialsError]
    }).annotate(RequiredAccess, "human")
  )
  .add(
    HttpApiEndpoint.post("deleteAccount", "/v1/auth/account/delete", {
      payload: DeleteAccountBody,
      success: Schema.Struct({ deleted: Schema.Literal(true) }),
      error: [ForbiddenError, PasswordRequiredError, InvalidCredentialsError]
    }).annotate(RequiredAccess, "human")
  )
  .middleware(Authority)
