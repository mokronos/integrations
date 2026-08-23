import { Schema } from "effect"

const GoogleTokenResponse = Schema.Struct({
  access_token: Schema.String
})

const GoogleIdentityResponse = Schema.Struct({
  sub: Schema.String,
  email: Schema.String,
  email_verified: Schema.Boolean
})

const decodeGoogleTokenText = Schema.decodeUnknownSync(
  Schema.fromJsonString(GoogleTokenResponse)
)
const decodeGoogleIdentityText = Schema.decodeUnknownSync(
  Schema.fromJsonString(GoogleIdentityResponse)
)

export interface GoogleIdentityOAuth {
  readonly clientId: string
  readonly clientSecret: string
  readonly publicUrlOf: () => string | undefined
  readonly fetch?: typeof globalThis.fetch
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

export const resolveGoogleIdentity = async (
  options: GoogleIdentityOAuth,
  code: string
): Promise<GoogleIdentity> => {
  const doFetch = options.fetch ?? globalThis.fetch
  const tokenResponse = await doFetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: options.clientId,
      client_secret: options.clientSecret,
      redirect_uri: googleIdentityCallbackUrl(options),
      grant_type: "authorization_code"
    })
  })
  if (!tokenResponse.ok) {
    throw new Error(`Google rejected the authorization code (HTTP ${tokenResponse.status})`)
  }
  const token = decodeGoogleTokenText(await tokenResponse.text())

  const identityResponse = await doFetch(
    "https://openidconnect.googleapis.com/v1/userinfo",
    { headers: { authorization: `Bearer ${token.access_token}` } }
  )
  if (!identityResponse.ok) {
    throw new Error(`Google did not return an identity (HTTP ${identityResponse.status})`)
  }
  const identity = decodeGoogleIdentityText(await identityResponse.text())
  if (!identity.email_verified) {
    throw new Error("Google did not verify this account's email address")
  }
  return { providerSubject: identity.sub, email: identity.email }
}
