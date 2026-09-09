import { Deferred, Duration, Effect, Schema } from "effect"
import type { Scope } from "effect"
import {
  completeOAuthFlow,
  createOAuthClient,
  probeOAuthServer,
  registerOAuthClient,
  startOAuthFlow
} from "@integrations/host"
import type { CatalogStore, IntegrationHost, OAuthFlows } from "@integrations/host"
import { AuthMethod, Connection, whenPresent } from "@integrations/contracts"
import { oauthSetupGuidance } from "./oauth-guidance.ts"

export class OAuthFlowError extends Schema.TaggedError<OAuthFlowError>()(
  "OAuthFlowError",
  {
    stage: Schema.Literals([
      "configure",
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

const step = <A, E extends { readonly message: string }, R>(
  stage: OAuthFlowError["stage"],
  detail: string,
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, OAuthFlowError, R> =>
  Effect.mapError(effect, (cause) => new OAuthFlowError({
    stage,
    detail: `${detail}: ${cause.message}`,
    cause
  }))

const decodeRequest = (
  input: AuthorizationRequest
): Effect.Effect<AuthorizationRequest, OAuthFlowError> =>
  Schema.decodeUnknownEffect(AuthorizationRequest)(input).pipe(
    Effect.mapError((cause) => new OAuthFlowError({
      stage: "configure",
      detail: "The authorization request was not in the expected shape",
      cause
    }))
  )

const AuthorizationRequest = Schema.Struct({
  integration: Schema.String,
  connection: Schema.String,
  authMethod: AuthMethod,
  clientId: Schema.optional(Schema.String),
  clientSecret: Schema.optional(Schema.String),
  timeoutMs: Schema.optional(Schema.Number)
})
type AuthorizationRequest = typeof AuthorizationRequest.Type

export type OAuthOperations = IntegrationHost | OAuthFlows | CatalogStore

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

export const oauthBrowserResponse = (options: {
  readonly title: string
  readonly message: string
  readonly status?: number
}): Response => new Response(oauthBrowserPage(options), {
  status: options.status ?? 200,
  headers: { "content-type": "text/html; charset=utf-8" }
})

const prepareFlow = Effect.fn("OAuth.prepareFlow")(function*(
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
    : yield* step("discover", `Could not read ${oauth.discoveryUrl}`,
      probeOAuthServer(oauth.discoveryUrl))
  const authorizationUrl = oauth.authorizationUrl ?? discovered?.authorizationUrl
  const tokenUrl = oauth.tokenUrl ?? discovered?.tokenUrl
  const resource = oauth.resource ?? discovered?.resource
  if (authorizationUrl === undefined || tokenUrl === undefined) {
    return yield* new OAuthFlowError({
      stage: "discover",
      detail: "Could not discover OAuth authorization and token endpoints"
    })
  }
  const clientSlug = `${input.integration}-wf`
  let client: string
  if (input.clientId !== undefined) {
    client = yield* step("register", `Could not record the OAuth client for ${input.integration}`,
      createOAuthClient({
        slug: clientSlug,
        integration: input.integration,
        authorizationUrl,
        tokenUrl,
        clientId: input.clientId!,
        ...whenPresent("clientSecret", input.clientSecret),
        ...whenPresent("resource", resource),
        scopes: oauth.scopes ?? discovered?.scopesSupported ?? []
      }))
  } else {
    const registrationEndpoint = oauth.registrationEndpoint ?? discovered?.registrationEndpoint
    if (registrationEndpoint === null || registrationEndpoint === undefined) {
      return yield* new OAuthFlowError({
        stage: "configure",
        detail: oauthSetupGuidance({
          integration: input.integration,
          method: input.authMethod,
          redirectUri
        })
      })
    }
    client = yield* step("register", `${input.integration} refused dynamic client registration`,
      registerOAuthClient({
        slug: clientSlug,
        integration: input.integration,
        redirectUri,
        registrationEndpoint,
        authorizationUrl,
        tokenUrl,
        scopes: oauth.scopes ?? discovered?.scopesSupported ?? [],
        ...whenPresent("issuer", discovered?.issuer),
        ...whenPresent("resource", resource),
        ...whenPresent(
          "tokenEndpointAuthMethodsSupported",
          discovered?.tokenEndpointAuthMethodsSupported
        )
      }))
  }
  const started = yield* step("start", `Could not start authorization for ${input.integration}`,
    startOAuthFlow({
      client,
      integration: input.integration,
      connection: input.connection,
      template: input.authMethod.template,
      redirectUri
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

export interface HostedAuthorizationFlow {
  readonly status: "pending"
  readonly state: string
  readonly authorizationUrl: string
  readonly complete: (input: {
    readonly code: string
  }) => Effect.Effect<Connection, OAuthFlowError, OAuthOperations>
}

export type HostedAuthorization =
  | HostedAuthorizationFlow
  | { readonly status: "connected"; readonly connection: Connection }

export const startHostedAuthorization = Effect.fn("OAuth.startHosted")(function*(
  input: AuthorizationRequest & { readonly publicUrl: string }
): Effect.fn.Return<HostedAuthorization, OAuthFlowError, OAuthOperations> {
  const options = yield* decodeRequest(input)
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
      step("exchange", `${input.integration} refused the authorization code`,
        completeOAuthFlow({ state, code }))
  }
})

type CallbackArrival =
  | { readonly outcome: "code"; readonly code: string; readonly callbackDomain: string | null }
  | { readonly outcome: "refused"; readonly detail: string }

export const authorizeInBrowser = Effect.fn("OAuth.authorizeInBrowser")(function*(
  input: AuthorizationRequest & {
    readonly open?: (url: string) => void | Promise<void>
    readonly onAuthorizationUrl?: (url: string) => void
  }
): Effect.fn.Return<Connection, OAuthFlowError, Scope.Scope | OAuthOperations> {
  const arrived = yield* Deferred.make<CallbackArrival>()
  const rendered = Promise.withResolvers<Response>()
  let callbackStarted = false
  let expectedState: string | undefined

  const server = yield* Effect.acquireRelease(
    Effect.sync(() =>
      Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request): Promise<Response> {
          const url = new URL(request.url)
          if (request.method !== "GET" || url.pathname !== "/oauth/callback") {
            return new Response("Not found", { status: 404 })
          }
          if (callbackStarted) {
            return oauthBrowserResponse({
              title: "Authorization unavailable",
              message: "This authorization callback is no longer active. Return to the terminal and try again.",
              status: 409
            })
          }
          const state = url.searchParams.get("state")
          const code = url.searchParams.get("code")
          if (state === null || expectedState === undefined || state !== expectedState) {
            return oauthBrowserResponse({
              title: "Authorization failed",
              message: "The callback state could not be verified. Return to the terminal and try again.",
              status: 400
            })
          }
          callbackStarted = true
          Deferred.doneUnsafe(
            arrived,
            Effect.succeed(
              code === null
                ? {
                  outcome: "refused" as const,
                  detail: url.searchParams.get("error_description")
                    ?? "OAuth callback is missing state or code"
                }
                : {
                  outcome: "code" as const,
                  code,
                  callbackDomain: url.searchParams.get("domain") ?? url.searchParams.get("site")
                }
            )
          )
          return await rendered.promise
        }
      })
    ),
    (running) =>
      Effect.promise(async () => {
        rendered.resolve(oauthBrowserResponse({
          title: "Authorization failed",
          message: "The authorization did not complete. Return to the terminal and try again.",
          status: 400
        }))
        await running.stop(false)
      })
  )

  const timeoutMillis = Math.max(1_000, input.timeoutMs ?? 300_000)
  const options = yield* decodeRequest(input)
  const prepared = yield* prepareFlow(
    options,
    `http://127.0.0.1:${server.port}/oauth/callback`
  )
  if (prepared.status === "connected") return prepared.connection

  expectedState = prepared.state
  input.onAuthorizationUrl?.(prepared.authorizationUrl)
  if (input.open !== undefined) {
    const open = input.open
    yield* step("start", "Could not open the authorization URL",
      Effect.tryPromise({
        try: async () => {
          await open(prepared.authorizationUrl)
        },
        catch: (cause) => ({
          message: cause instanceof Error ? cause.message : String(cause)
        })
      }))
  }

  const arrival = yield* Deferred.await(arrived).pipe(
    Effect.timeoutOrElse({
      duration: Duration.millis(timeoutMillis),
      orElse: () => new OAuthFlowError({
        stage: "timeout",
        detail: `OAuth authorization timed out after ${Math.ceil(timeoutMillis / 1000)} seconds`
      })
    })
  )

  if (arrival.outcome === "refused") {
    rendered.resolve(oauthBrowserResponse({
      title: "Authorization failed",
      message: "The provider did not return a usable authorization code.",
      status: 400
    }))
    return yield* new OAuthFlowError({ stage: "callback", detail: arrival.detail })
  }

  const exchanged = yield* Effect.result(step(
    "exchange",
    `${input.integration} refused the authorization code`,
    completeOAuthFlow({ state: prepared.state, code: arrival.code })
  ))
  if (exchanged._tag === "Failure") {
    rendered.resolve(oauthBrowserResponse({
      title: "Authorization failed",
      message: `The callback could not be verified: ${exchanged.failure.message}`,
      status: 400
    }))
    return yield* exchanged.failure
  }
  rendered.resolve(oauthBrowserResponse({
    title: "Account connected",
    message: "Authorization completed. You can close this window and return to wf."
  }))
  return exchanged.success
})
