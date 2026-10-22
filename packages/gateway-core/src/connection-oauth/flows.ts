import { Clock, Crypto, Effect, Option, Schema } from "effect"
import type { Scope } from "effect"
import {
  completeOAuthFlow,
  discoverOAuth,
  findOAuthClient,
  gatewayOAuthClientSlug,
  httpsOnlyUrlPolicy,
  parseDestination,
  registerOAuthClient,
  saveOAuthClient,
  startOAuthFlow
} from "@integragents/integrations"
import type { CatalogStore, Integrations, OAuthFlows, OAuthSetup } from "@integragents/integrations"
import { AuthMethod, Connection, ConnectionOwner, webCrypto, whenPresent } from "@integragents/contracts"
import { sha256Hex } from "../keys.ts"
import { oauthSetupGuidance } from "./guidance.ts"

export class OAuthFlowError extends Schema.TaggedError<OAuthFlowError>()("OAuthFlowError", {
  stage: Schema.Literals([
    "configure",
    "client-required",
    "discover",
    "register",
    "start",
    "callback",
    "exchange",
    "timeout"
  ]),
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect())
}) {
  override get message(): string {
    return `OAuth ${this.stage} failed: ${this.detail}`
  }
}

export const oauthStep = <A, E extends { readonly message: string }, R>(
  stage: OAuthFlowError["stage"],
  detail: string,
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, OAuthFlowError, R> =>
  Effect.mapError(
    effect,
    (cause) =>
      new OAuthFlowError({
        stage,
        detail: `${detail}: ${cause.message}`,
        cause
      })
  )

export const decodeAuthorizationRequest = (
  input: AuthorizationRequest
): Effect.Effect<AuthorizationRequest, OAuthFlowError> =>
  Schema.decodeUnknownEffect(AuthorizationRequest)(input).pipe(
    Effect.mapError(
      (cause) =>
        new OAuthFlowError({
          stage: "configure",
          detail: "The authorization request was not in the expected shape",
          cause
        })
    )
  )

export const AuthorizationRequest = Schema.Struct({
  integration: Schema.String,
  connection: Schema.String,
  owner: Schema.optional(ConnectionOwner),
  authMethod: AuthMethod,
  clientId: Schema.optional(Schema.String),
  clientSecret: Schema.optional(Schema.String),
  timeoutMs: Schema.optional(Schema.Number)
})
export type AuthorizationRequest = typeof AuthorizationRequest.Type

export type OAuthOperations = Integrations | OAuthFlows | CatalogStore

/**
 * Runs an authorization end to end without a public callback URL: the host
 * owns the listener the provider redirects to. Only a process that can bind a
 * local port and has a human at hand can offer one.
 */
export type LocalAuthorizer = (
  input: AuthorizationRequest & { readonly onAuthorizationUrl?: (url: string) => void }
) => Effect.Effect<Connection, OAuthFlowError, Scope.Scope | OAuthOperations>

export const oauthBrowserPage = (options: {
  readonly title: string
  readonly message: string
}): string => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${options.title}</title></head>
<body style="font:16px system-ui,sans-serif;max-width:38rem;margin:12vh auto;padding:0 1.5rem;line-height:1.5">
<h1>${options.title}</h1><p>${options.message}</p>
</body>
</html>`

/** Where the gateway publishes its OAuth client metadata document, for servers that accept one as a client id. */
export const clientMetadataPath = "/v1/oauth/client-metadata.json"
export const oauthCallbackPath = "/v1/oauth/callback"

const trimmedOrigin = (publicUrl: string) => publicUrl.replace(/\/+$/, "")

/**
 * The client id a server that supports client ID metadata documents can use
 * without registration: only over HTTPS on a public host, and only when the
 * redirect is the callback that document lists.
 */
const metadataDocumentClientId = (
  setup: OAuthSetup,
  publicUrl: string | undefined,
  redirectUri: string
): string | undefined => {
  if (publicUrl === undefined || !setup.discovered) return undefined
  if (setup.server["client_id_metadata_document_supported"] !== true) return undefined
  const methods = setup.server.token_endpoint_auth_methods_supported
  if (methods !== undefined && !methods.includes("none")) return undefined
  const origin = trimmedOrigin(publicUrl)
  if (redirectUri !== `${origin}${oauthCallbackPath}`) return undefined
  return parseDestination(`${origin}${clientMetadataPath}`, httpsOnlyUrlPolicy)?.href
}

/**
 * A client registered for one redirect, issuer and scope set is only reused
 * for exactly those: providers match redirects exactly, and a client
 * registered for fewer scopes cannot be assumed to allow more.
 */
const registeredClientSlug = (input: {
  readonly integration: string
  readonly redirectUri: string
  readonly setup: OAuthSetup
  readonly metadataClientId: string | undefined
}) =>
  sha256Hex(
    JSON.stringify([
      input.integration,
      input.redirectUri,
      input.setup.server.issuer,
      input.metadataClientId ?? null,
      [...input.setup.scopes].sort()
    ])
  ).pipe(
    Effect.provideService(Crypto.Crypto, webCrypto),
    Effect.map((hash) => `${input.integration}-${hash.slice(0, 24)}`)
  )

export const prepareFlow = Effect.fn("OAuth.prepareFlow")(function* (
  input: AuthorizationRequest,
  redirectUri: string,
  publicUrl?: string
): Effect.fn.Return<
  | { readonly status: "connected"; readonly connection: Connection }
  | { readonly status: "pending"; readonly state: string; readonly authorizationUrl: string },
  OAuthFlowError,
  OAuthOperations
> {
  if (input.authMethod.kind !== "oauth" || input.authMethod.oauth === undefined) {
    return yield* new OAuthFlowError({
      stage: "configure",
      detail: `Auth method ${input.authMethod.id} is not OAuth`
    })
  }
  const oauth = input.authMethod.oauth
  const setup = yield* oauthStep(
    "discover",
    `Could not discover how ${input.integration} authorizes`,
    discoverOAuth({
      ...whenPresent("discoveryUrl", oauth.discoveryUrl),
      ...whenPresent("authorizationUrl", oauth.authorizationUrl),
      ...whenPresent("tokenUrl", oauth.tokenUrl),
      ...whenPresent("resource", oauth.resource),
      ...whenPresent("scopes", oauth.scopes),
      ...whenPresent("registrationEndpoint", oauth.registrationEndpoint)
    })
  )
  const suppliedSlug = gatewayOAuthClientSlug(input.integration)
  const client = yield* Effect.gen(function* () {
    if (input.clientId !== undefined) {
      return yield* oauthStep(
        "register",
        `Could not record the OAuth client for ${input.integration}`,
        saveOAuthClient({
          slug: suppliedSlug,
          integration: input.integration,
          setup,
          clientId: input.clientId,
          ...whenPresent("clientSecret", input.clientSecret)
        })
      )
    }
    const supplied = yield* oauthStep(
      "register",
      `Could not read the OAuth client for ${input.integration}`,
      findOAuthClient(suppliedSlug)
    )
    if (Option.isSome(supplied)) return supplied.value.slug

    const metadataClientId = metadataDocumentClientId(setup, publicUrl, redirectUri)
    const slug = yield* registeredClientSlug({ integration: input.integration, redirectUri, setup, metadataClientId })
    const saved = yield* oauthStep(
      "register",
      `Could not read the OAuth client for ${input.integration}`,
      findOAuthClient(slug)
    )
    const now = yield* Clock.currentTimeMillis
    if (Option.isSome(saved) && (saved.value.secretExpiresAt === undefined || saved.value.secretExpiresAt > now)) {
      return saved.value.slug
    }
    if (metadataClientId !== undefined) {
      return yield* oauthStep(
        "register",
        `Could not record the OAuth client for ${input.integration}`,
        saveOAuthClient({
          slug,
          integration: input.integration,
          setup,
          clientId: metadataClientId,
          tokenAuthMethod: "none"
        })
      )
    }
    if (setup.server.registration_endpoint === undefined) {
      return yield* new OAuthFlowError({
        stage: "client-required",
        detail: oauthSetupGuidance({
          integration: input.integration,
          method: input.authMethod,
          redirectUri
        })
      })
    }
    return yield* oauthStep(
      "register",
      `${input.integration} refused dynamic client registration`,
      registerOAuthClient({ slug, integration: input.integration, setup, redirectUri })
    )
  })
  const started = yield* oauthStep(
    "start",
    `Could not start authorization for ${input.integration}`,
    startOAuthFlow({
      client,
      integration: input.integration,
      connection: input.connection,
      template: input.authMethod.template,
      redirectUri,
      ...whenPresent("owner", input.owner)
    })
  )
  if (started.status === "connected") {
    return { status: "connected", connection: started.connection }
  }
  return {
    status: "pending",
    state: started.state,
    authorizationUrl: started.authorizationUrl
  }
})

export interface RemoteAuthorizationFlow {
  readonly status: "pending"
  readonly state: string
  readonly authorizationUrl: string
  readonly complete: (callback: URLSearchParams) => Effect.Effect<Connection, OAuthFlowError, OAuthOperations>
}

export type RemoteAuthorization =
  | RemoteAuthorizationFlow
  | { readonly status: "connected"; readonly connection: Connection }

export const startRemoteAuthorization = Effect.fn("OAuth.startRemote")(function* (
  input: AuthorizationRequest & { readonly publicUrl: string }
): Effect.fn.Return<RemoteAuthorization, OAuthFlowError, OAuthOperations> {
  const options = yield* decodeAuthorizationRequest(input)
  const origin = trimmedOrigin(input.publicUrl)
  const prepared = yield* prepareFlow(options, `${origin}${oauthCallbackPath}`, origin)
  if (prepared.status === "connected") {
    return { status: "connected", connection: prepared.connection }
  }
  const state = prepared.state
  return {
    status: "pending",
    state,
    authorizationUrl: prepared.authorizationUrl,
    complete: (callback) =>
      oauthStep("exchange", `${input.integration} refused the authorization code`, completeOAuthFlow(callback))
  }
})
