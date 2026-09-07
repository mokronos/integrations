import { Deferred, Duration, Effect, Schema } from "effect"
import type { Scope } from "effect"
import {
  completeOAuthFlow,
  createOAuthClient,
  probeOAuthServer,
  registerOAuthClient,
  startOAuthFlow
} from "@mokronos/integrations"
import type { CatalogStore, IntegrationHost, OAuthFlows } from "@mokronos/integrations"
import { AuthMethod, Connection, whenPresent } from "@mokronos/contracts"
import { oauthSetupGuidance } from "./oauth-guidance.ts"

/** Why an authorization did not finish.
 *
 *  Every one of these used to be `throw new Error(...)` inside an async
 *  function. They were caught eventually — `oauth-sessions` wraps these calls in
 *  `Effect.tryPromise` — but they all arrived as one opaque `OAuthSessionError`
 *  with an `unknown` cause, so "this integration does not do OAuth" and "the
 *  provider's token endpoint refused us" were the same error to every reader.
 *
 *  `stage` is what a human needs first: it says which half of the flow broke,
 *  and therefore whether the remedy is configuration, a retry, or asking the
 *  person to authorize again. */
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

/** One step of a flow, tagged with where it sits.
 *
 *  The host's failures are already typed; this says which half of the
 *  authorization they happened in, which is what a reader needs first and what
 *  no single host error could say on its own. */
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

/** Re-checks the request at the start of a flow.
 *
 *  The static type says this cannot fail, and the runtime disagrees often
 *  enough to be worth the check: `authMethod` is whatever the host derived from
 *  probing a vendor, and the two string fields arrive from the wire. What
 *  changed is the failure — `decodeUnknownSync` threw, which made a malformed
 *  request indistinguishable from a provider outage by the time anyone saw it. */
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

// Opening a browser is the client's job — the gateway may be running headless
// on another machine. It returns the authorization URL and lets the caller
// decide how a human reaches it.

const AuthorizationRequest = Schema.Struct({
  integration: Schema.String,
  connection: Schema.String,
  authMethod: AuthMethod,
  clientId: Schema.optional(Schema.String),
  clientSecret: Schema.optional(Schema.String),
  timeoutMs: Schema.optional(Schema.Number)
})
type AuthorizationRequest = typeof AuthorizationRequest.Type

/** What an authorization reaches for. Named as one type so a flow's signature
 *  says which host services it needs rather than requiring the whole host. */
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

/** The provider-independent half of every OAuth authorization: discover (or be
 *  told) the endpoints, put an OAuth client in place, and start the flow at a
 *  given redirect URI.
 *
 * Everything after this point differs by where the browser lands. Locally it
 * lands on an ephemeral loopback listener this process owns; hosted, it lands
 * back on the gateway's own public URL. */
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
        // A hand-registered client still has to ask for something: an
        // authorization request with no `scope` buys a token that opens nothing.
        scopes: oauth.scopes ?? discovered?.scopesSupported ?? []
      }))
  } else {
    const registrationEndpoint = oauth.registrationEndpoint ?? discovered?.registrationEndpoint
    if (registrationEndpoint === null || registrationEndpoint === undefined) {
      // The one failure that is entirely the operator's to fix, so it carries
      // the setup instructions rather than a diagnosis.
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

/** A flow whose callback arrives over HTTP at the gateway's own public URL
 *  rather than on a private loopback port. The gateway keeps the `complete`
 *  function alongside the session until the provider calls home. */
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

/** Starts an authorization that completes against a stable public callback —
 *  `POST /v1/connections/oauth` hands out the URL, `GET /v1/oauth/callback`
 *  finishes the flow when the provider redirects to it. No socket of our own:
 *  behind a reverse proxy or on a shared host, binding random local ports is
 *  not something we can do. */
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

/** What the provider's redirect carried, once the listener has vouched for its
 *  state. The exchange happens on the fiber, not in the request handler. */
type CallbackArrival =
  | { readonly outcome: "code"; readonly code: string; readonly callbackDomain: string | null }
  | { readonly outcome: "refused"; readonly detail: string }

/** Authorization through a loopback listener this process owns.
 *
 *  Two things changed from the async version, and both are about what happens
 *  when it does not go to plan:
 *
 *  - The listener is acquired and released as a scoped resource, so it is torn
 *    down when the fiber is interrupted as well as when the flow settles. The
 *    old `finally` only covered the second, so a cancelled request leaked an
 *    open port.
 *  - The request handler no longer performs the token exchange. It vouches for
 *    the callback's state, hands what arrived to the fiber through a
 *    {@link Deferred}, and waits for the fiber to tell it what to render. All
 *    the work — and every failure — is on the fiber, where it is typed. */
export const authorizeInBrowser = Effect.fn("OAuth.authorizeInBrowser")(function*(
  input: AuthorizationRequest & {
    readonly open?: (url: string) => void | Promise<void>
    readonly onAuthorizationUrl?: (url: string) => void
  }
): Effect.fn.Return<Connection, OAuthFlowError, Scope.Scope | OAuthOperations> {
  const arrived = yield* Deferred.make<CallbackArrival>()
  // The page the human sees. The handler blocks on it so the browser is told
  // what actually happened rather than an optimistic "done".
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
            // Deliberately does not wake the fiber: a forged or replayed
            // callback must not be able to end someone else's flow.
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
        // Whoever is still holding the page gets one rather than hanging on a
        // socket that is about to close.
        rendered.resolve(oauthBrowserResponse({
          title: "Authorization failed",
          message: "The authorization did not complete. Return to the terminal and try again.",
          status: 400
        }))
        // Graceful: the fiber settles as soon as the exchange does, which is
        // before Bun has flushed the page the human is waiting on. Forcing the
        // socket shut here reset it and the browser showed nothing. (The async
        // version deferred waking the caller with `setTimeout(…, 0)` for the
        // same reason; this says it rather than implying it.)
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
