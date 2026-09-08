import { Effect, Schema } from "effect"
import { HttpBody, HttpClient, HttpClientResponse } from "effect/unstable/http"

const GoogleTokenResponse = Schema.Struct({
  access_token: Schema.String
})

const GoogleIdentityResponse = Schema.Struct({
  sub: Schema.String,
  email: Schema.String,
  email_verified: Schema.Boolean
})

const decodeGoogleToken = Schema.decodeUnknownEffect(GoogleTokenResponse)
const decodeGoogleIdentity = Schema.decodeUnknownEffect(GoogleIdentityResponse)

export class GoogleIdentityError extends Schema.TaggedError<GoogleIdentityError>()(
  "GoogleIdentityError",
  { message: Schema.String }
) {}

export interface GoogleIdentityOAuth {
  readonly clientId: string
  readonly clientSecret: string
  readonly publicUrlOf: () => string | undefined
}

export interface GoogleIdentity {
  readonly providerSubject: string
  readonly email: string
}

export const googleIdentityCallbackUrl = (options: GoogleIdentityOAuth): string => {
  const publicUrl = options.publicUrlOf()
  if (publicUrl === undefined) {
    throw new Error(
      "Google sign-in needs INTEGRATIONS_PUBLIC_URL, or a local gateway running on its configured port"
    )
  }
  return `${publicUrl.replace(/\/+$/, "")}/v1/auth/google/callback`
}

export const googleIdentityAuthorizationUrl = (
  options: GoogleIdentityOAuth,
  state: string
): string => {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth")
  url.search = new URLSearchParams({
    client_id: options.clientId,
    redirect_uri: googleIdentityCallbackUrl(options),
    response_type: "code",
    scope: "openid email",
    state,
    prompt: "select_account"
  }).toString()
  return url.toString()
}

export const resolveGoogleIdentity = Effect.fn("GoogleIdentity.resolve")(function*(
  options: GoogleIdentityOAuth,
  code: string
): Effect.fn.Return<GoogleIdentity, GoogleIdentityError, HttpClient.HttpClient> {
  const client = yield* HttpClient.HttpClient

  const token = yield* client.post("https://oauth2.googleapis.com/token", {
    body: HttpBody.urlParams({
      code,
      client_id: options.clientId,
      client_secret: options.clientSecret,
      redirect_uri: googleIdentityCallbackUrl(options),
      grant_type: "authorization_code"
    })
  }).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((response) => response.json),
    Effect.flatMap(decodeGoogleToken),
    Effect.mapError(() =>
      new GoogleIdentityError({ message: "Google rejected the authorization code" })
    )
  )

  const identity = yield* client.get("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { authorization: `Bearer ${token.access_token}` }
  }).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((response) => response.json),
    Effect.flatMap(decodeGoogleIdentity),
    Effect.mapError(() =>
      new GoogleIdentityError({ message: "Google did not return an identity" })
    )
  )

  if (!identity.email_verified) {
    return yield* new GoogleIdentityError({
      message: "Google did not verify this account's email address"
    })
  }
  return { providerSubject: identity.sub, email: identity.email }
})
