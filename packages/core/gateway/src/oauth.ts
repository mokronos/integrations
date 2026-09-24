import { Effect, Option, Schema } from "effect"
import type { Scope } from "effect"
import {
  completeOAuthFlow,
  createOAuthClient,
  findOAuthClient,
  probeOAuthServer,
  registerOAuthClient,
  startOAuthFlow
} from "@integragents/host"
import type { CatalogStore, Integrations, OAuthFlows } from "@integragents/host"
import { AuthMethod, Connection, ConnectionOwner, whenPresent } from "@integragents/contracts"
import { oauthSetupGuidance } from "./oauth-guidance.ts"

export class OAuthFlowError extends Schema.TaggedError<OAuthFlowError>()(
  "OAuthFlowError",
  {
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
  }
) {
  override get message(): string {
    return `OAuth ${this.stage} failed: ${this.detail}`
  }
}

export const oauthStep = <A, E extends { readonly message: string }, R>(
  stage: OAuthFlowError["stage"],
  detail: string,
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, OAuthFlowError, R> =>
  Effect.mapError(effect, (cause) => new OAuthFlowError({
    stage,
    detail: `${detail}: ${cause.message}`,
    cause
  }))

const offlineAccessScope = "offline_access"

// Servers reject scopes they do not publish, so this dialect only ships when
// discovery advertises it.
const requestedScopes = (
  configured: ReadonlyArray<string> | undefined,
  supported: ReadonlyArray<string> | undefined
): ReadonlyArray<string> => {
  const base = configured ?? supported ?? []
  return supported?.includes(offlineAccessScope) === true &&
      !base.includes(offlineAccessScope)
    ? [...base, offlineAccessScope]
    : base
}

export const decodeAuthorizationRequest = (
  input: AuthorizationRequest
): Effect.Effect<AuthorizationRequest, OAuthFlowError> =>
  Schema.decodeUnknownEffect(AuthorizationRequest)(input).pipe(
    Effect.mapError((cause) => new OAuthFlowError({
      stage: "configure",
      detail: "The authorization request was not in the expected shape",
      cause
    }))
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

export const prepareFlow = Effect.fn("OAuth.prepareFlow")(function*(
  input: AuthorizationRequest,
  redirectUri: string
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
  const discovered = oauth.discoveryUrl === undefined
    ? undefined
    : yield* oauthStep("discover", `Could not read ${oauth.discoveryUrl}`,
      probeOAuthServer(oauth.discoveryUrl))
  const authorizationUrl = oauth.authorizationUrl ?? discovered?.authorizationUrl
  const tokenUrl = oauth.tokenUrl ?? discovered?.tokenUrl
  const resource = oauth.resource ?? discovered?.resource
  const scopes = requestedScopes(oauth.scopes, discovered?.scopesSupported)
  if (authorizationUrl === undefined || tokenUrl === undefined) {
    return yield* new OAuthFlowError({
      stage: "discover",
      detail: "Could not discover OAuth authorization and token endpoints"
    })
  }
  const clientSlug = `${input.integration}-gateway`
  const reusable = input.clientId !== undefined
    ? false
    : Option.isSome(
      yield* oauthStep("register", `Could not read the OAuth client for ${input.integration}`,
        findOAuthClient(clientSlug))
    )
  let client: string
  if (input.clientId !== undefined) {
    client = yield* oauthStep("register", `Could not record the OAuth client for ${input.integration}`,
      createOAuthClient({
        slug: clientSlug,
        integration: input.integration,
        authorizationUrl,
        tokenUrl,
        clientId: input.clientId!,
        ...whenPresent("clientSecret", input.clientSecret),
        ...whenPresent("resource", resource),
        scopes
      }))
  } else if (reusable) {
    client = clientSlug
  } else {
    const registrationEndpoint = oauth.registrationEndpoint ?? discovered?.registrationEndpoint
    if (registrationEndpoint === null || registrationEndpoint === undefined) {
      return yield* new OAuthFlowError({
        stage: "client-required",
        detail: oauthSetupGuidance({
          integration: input.integration,
          method: input.authMethod,
          redirectUri
        })
      })
    }
    client = yield* oauthStep("register", `${input.integration} refused dynamic client registration`,
      registerOAuthClient({
        slug: clientSlug,
        integration: input.integration,
        redirectUri,
        registrationEndpoint,
        authorizationUrl,
        tokenUrl,
        scopes,
        ...whenPresent("issuer", discovered?.issuer),
        ...whenPresent("resource", resource)
      }))
  }
  const started = yield* oauthStep("start", `Could not start authorization for ${input.integration}`,
    startOAuthFlow({
      client,
      integration: input.integration,
      connection: input.connection,
      template: input.authMethod.template,
      redirectUri,
      ...whenPresent("owner", input.owner)
    }))
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
  readonly complete: (input: {
    readonly code: string
  }) => Effect.Effect<Connection, OAuthFlowError, OAuthOperations>
}

export type RemoteAuthorization =
  | RemoteAuthorizationFlow
  | { readonly status: "connected"; readonly connection: Connection }

export const startRemoteAuthorization = Effect.fn("OAuth.startRemote")(function*(
  input: AuthorizationRequest & { readonly publicUrl: string }
): Effect.fn.Return<RemoteAuthorization, OAuthFlowError, OAuthOperations> {
  const options = yield* decodeAuthorizationRequest(input)
  const prepared = yield* prepareFlow(options, `${input.publicUrl}/v1/oauth/callback`)
  if (prepared.status === "connected") {
    return { status: "connected", connection: prepared.connection }
  }
  const state = prepared.state
  return {
    status: "pending",
    state,
    authorizationUrl: prepared.authorizationUrl,
    complete: ({ code }) =>
      oauthStep("exchange", `${input.integration} refused the authorization code`,
        completeOAuthFlow({ state, code }))
  }
})
