import { optionalText, PositiveInt, PositiveIntFromString, whenPresent } from "@mokronos/contracts"
import { Config, Effect, Option, Schema } from "effect"

export const defaultRateLimitPerMinute = PositiveInt.make(600)

export interface GatewayEnvironment {
  readonly allowSignup: boolean
  readonly masterKey: Option.Option<string>
  readonly publicUrl: Option.Option<string>
  readonly googleClientId: Option.Option<string>
  readonly googleClientSecret: Option.Option<string>
  readonly rateLimitPerMinute: Option.Option<PositiveInt>
}

/**
 * Google sign-in needs both halves of the client credential. Half of one is a
 * misconfiguration worth naming rather than a reason to quietly stay signed
 * out, so it is rejected here where the values are read.
 */
const GoogleIdentity = Schema.Struct({
  clientId: Schema.optional(Schema.String),
  clientSecret: Schema.optional(Schema.String)
}).check(Schema.makeFilter((value) =>
  (value.clientId === undefined) === (value.clientSecret === undefined) ||
  "Google sign-in requires both INTEGRATIONS_GOOGLE_CLIENT_ID and INTEGRATIONS_GOOGLE_CLIENT_SECRET"
))

export const gatewayEnvironment: Effect.Effect<
  GatewayEnvironment,
  Config.ConfigError
> = Effect.gen(function*() {
  const googleClientId = yield* optionalText("INTEGRATIONS_GOOGLE_CLIENT_ID")
  const googleClientSecret = yield* optionalText("INTEGRATIONS_GOOGLE_CLIENT_SECRET")
  yield* Schema.decodeUnknownEffect(GoogleIdentity)({
    ...whenPresent("clientId", Option.getOrUndefined(googleClientId)),
    ...whenPresent("clientSecret", Option.getOrUndefined(googleClientSecret))
  }).pipe(Effect.mapError((cause) => new Config.ConfigError(cause)))

  return {
    allowSignup: yield* Config.boolean("INTEGRATIONS_ALLOW_SIGNUP").pipe(
      Config.withDefault(false)
    ),
    masterKey: yield* optionalText("INTEGRATIONS_MASTER_KEY"),
    publicUrl: yield* optionalText("INTEGRATIONS_PUBLIC_URL"),
    googleClientId,
    googleClientSecret,
    rateLimitPerMinute: yield* Config.option(
      Config.schema(PositiveIntFromString, "INTEGRATIONS_RATE_LIMIT")
    )
  }
})
