import { whenPresent } from "@mokronos/wfkit/optional"
import { Schema } from "effect"
import {
  completeExecutorOAuth,
  createExecutorOAuthClient,
  ExecutorAuthMethod,
  ExecutorConnection,
  type ExecutorAuth,
  probeExecutorOAuth,
  registerExecutorOAuthClient,
  startExecutorOAuth
} from "@mokronos/wfkit-executor"
import { oauthSetupGuidance } from "./oauth-guidance.ts"

// Opening a browser is the client's job — the gateway may be running headless
// on another machine. It returns the authorization URL and lets the caller
// decide how a human reaches it.

const AuthorizeExecutorOptions = Schema.Struct({
  integration: Schema.String,
  connection: Schema.String,
  authMethod: ExecutorAuthMethod,
  clientId: Schema.optional(Schema.String),
  clientSecret: Schema.optional(Schema.String),
  timeoutMs: Schema.optional(Schema.Number)
})
type AuthorizeExecutorOptions = typeof AuthorizeExecutorOptions.Type

type ExecutorOAuthOperations = Pick<
  ExecutorAuth,
  "probe" | "registerClient" | "createClient" | "start" | "complete"
>

const defaultExecutorAuth: ExecutorOAuthOperations = {
  probe: probeExecutorOAuth,
  registerClient: registerExecutorOAuthClient,
  createClient: createExecutorOAuthClient,
  start: startExecutorOAuth,
  complete: completeExecutorOAuth
}

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
const prepareFlow = async (
  input: AuthorizeExecutorOptions,
  redirectUri: string,
  auth: ExecutorOAuthOperations
): Promise<
  | { readonly status: "connected"; readonly connection: ExecutorConnection }
  | { readonly status: "pending"; readonly state: string; readonly authorizationUrl: string }
> => {
  if (input.authMethod.kind !== "oauth" || input.authMethod.oauth === undefined) {
    throw new Error(`Auth method ${input.authMethod.id} is not OAuth`)
  }
  const oauth = input.authMethod.oauth
  const discovered = oauth.discoveryUrl === undefined
    ? undefined
    : await auth.probe(oauth.discoveryUrl)
  const authorizationUrl = oauth.authorizationUrl ?? discovered?.authorizationUrl
  const tokenUrl = oauth.tokenUrl ?? discovered?.tokenUrl
  const resource = oauth.resource ?? discovered?.resource
  if (authorizationUrl === undefined || tokenUrl === undefined) {
    throw new Error("Executor could not discover OAuth authorization and token endpoints")
  }
  const clientSlug = `${input.integration}-wf`
  let client: string
  if (input.clientId !== undefined) {
    client = await auth.createClient({
      slug: clientSlug,
      integration: input.integration,
      authorizationUrl,
      tokenUrl,
      clientId: input.clientId,
      ...whenPresent("clientSecret", input.clientSecret),
      ...whenPresent("resource", resource)
    })
  } else {
    const registrationEndpoint = oauth.registrationEndpoint ?? discovered?.registrationEndpoint
    if (registrationEndpoint === null || registrationEndpoint === undefined) {
      throw new Error(oauthSetupGuidance({
        integration: input.integration,
        method: input.authMethod,
        redirectUri
      }))
    }
    client = await auth.registerClient({
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
    })
  }
  const started = await auth.start({
    client,
    integration: input.integration,
    connection: input.connection,
    template: input.authMethod.template,
    redirectUri
  })
  if (started.status === "connected") {
    return { status: "connected", connection: started.connection }
  }
  return {
    status: "pending",
    state: started.state,
    authorizationUrl: started.authorizationUrl
  }
}

/** A flow whose callback arrives over HTTP at the gateway's own public URL
 *  rather than on a private loopback port. The gateway keeps the `complete`
 *  function alongside the session until the provider calls home. */
export interface HostedAuthorizationFlow {
  readonly status: "pending"
  readonly state: string
  readonly authorizationUrl: string
  readonly complete: (input: {
    readonly code: string
    readonly callbackDomain?: string | null
  }) => Promise<ExecutorConnection>
}

export type HostedAuthorization =
  | HostedAuthorizationFlow
  | { readonly status: "connected"; readonly connection: ExecutorConnection }

/** Starts an authorization that completes against a stable public callback —
 *  `POST /v1/connections/oauth` hands out the URL, `GET /v1/oauth/callback`
 *  finishes the flow when the provider redirects to it. No socket of our own:
 *  behind a reverse proxy or on a shared host, binding random local ports is
 *  not something we can do. */
export const startHostedExecutorOAuth = async (
  input: AuthorizeExecutorOptions & { readonly publicUrl: string },
  auth: ExecutorOAuthOperations = defaultExecutorAuth
): Promise<HostedAuthorization> => {
  const options = Schema.decodeUnknownSync(AuthorizeExecutorOptions)(input)
  const prepared = await prepareFlow(options, `${input.publicUrl}/v1/oauth/callback`, auth)
  if (prepared.status === "connected") {
    return { status: "connected", connection: prepared.connection }
  }
  const state = prepared.state
  return {
    status: "pending",
    state,
    authorizationUrl: prepared.authorizationUrl,
    complete: async ({ code, callbackDomain }) => {
      // A null callbackDomain is meaningful to some providers (it changes the
      // host the executor completes against); only absence means "not given".
      const completeInput = { state, code, ...whenPresent("callbackDomain", callbackDomain) }
      return await auth.complete(completeInput)
    }
  }
}

export const authorizeExecutorInBrowser = async (
  input: AuthorizeExecutorOptions & {
    readonly open?: (url: string) => void | Promise<void>
    readonly onAuthorizationUrl?: (url: string) => void
  },
  auth: ExecutorOAuthOperations = defaultExecutorAuth
): Promise<ExecutorConnection> => {
  const completion = Promise.withResolvers<ExecutorConnection>()
  let callbackStarted = false
  let expectedState: string | undefined
  const server = Bun.serve({
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
      if (code === null) {
        const error = new Error(url.searchParams.get("error_description") ?? "OAuth callback is missing state or code")
        setTimeout(() => completion.reject(error), 0)
        return oauthBrowserResponse({
          title: "Authorization failed",
          message: "The provider did not return a usable authorization code.",
          status: 400
        })
      }
      try {
        const connection = await auth.complete({
          state,
          code,
          callbackDomain: url.searchParams.get("domain") ?? url.searchParams.get("site")
        })
        setTimeout(() => completion.resolve(connection), 0)
        return oauthBrowserResponse({
          title: "Account connected",
          message: "Authorization completed. You can close this window and return to wf."
        })
      } catch (error) {
        setTimeout(() => completion.reject(error), 0)
        return oauthBrowserResponse({
          title: "Authorization failed",
          message: error instanceof Error && error.message.length > 0
            ? `The callback could not be verified: ${error.message}`
            : "The callback could not be verified. Return to the terminal for details and try again.",
          status: 400
        })
      }
    }
  })
  const timeoutMs = Math.max(1_000, input.timeoutMs ?? 300_000)
  const timeout = setTimeout(
    () => completion.reject(new Error(`OAuth authorization timed out after ${Math.ceil(timeoutMs / 1000)} seconds`)),
    timeoutMs
  )
  try {
    const options = Schema.decodeUnknownSync(AuthorizeExecutorOptions)(input)
    const prepared = await prepareFlow(options, `http://127.0.0.1:${server.port}/oauth/callback`, auth)
    if (prepared.status === "connected") {
      return prepared.connection
    }
    expectedState = prepared.state
    input.onAuthorizationUrl?.(prepared.authorizationUrl)
    await input.open?.(prepared.authorizationUrl)
    return await completion.promise
  } finally {
    clearTimeout(timeout)
    server.stop(true)
  }
}
