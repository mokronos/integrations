import { describe, expect, test } from "bun:test"
import type { AuthMethod, Connection } from "@mokronos/contracts"
import { ConnectionName, IntegrationSlug } from "@mokronos/contracts"
import { Cause, Effect, Exit, Result } from "effect"
import { authorizeInBrowser, OAuthFlowError } from "../src/oauth.ts"
import { createOAuthSessions } from "../src/oauth-sessions.ts"
import type { OAuthOperations } from "../src/oauth.ts"

/** The loopback authorization path, which nothing exercised before.
 *
 *  It is testable without a browser: the caller supplies the OAuth operations,
 *  and the redirect URI the flow binds is handed to `start`, so a test can read
 *  the port off it and drive the callback with `fetch`. What a human would do in
 *  a browser is one GET. */

const oauthMethod: AuthMethod = {
  id: "oauth",
  label: "OAuth",
  kind: "oauth",
  template: "oauth",
  oauth: {
    authorizationUrl: "https://provider.test/authorize",
    tokenUrl: "https://provider.test/token",
    scopes: ["read"]
  }
}

const connected: Connection = {
  owner: "org",
  name: ConnectionName.make("primary"),
  integration: IntegrationSlug.make("provider"),
  template: "oauth",
  address: "connections.provider.org.primary",
  provider: "provider",
  status: "connected"
}

const notUsed = (member: string) => () => {
  throw new Error(`${member} is not used by these tests`)
}

/** Records the redirect URI the flow bound, so the test can reach the listener
 *  the same way a provider would. */
const operations = (behaviour: {
  readonly onComplete?: () => Promise<Connection>
} = {}) => {
  let redirectUri: string | undefined
  const auth: OAuthOperations = {
    probe: notUsed("probe"),
    registerClient: notUsed("registerClient"),
    createClient: async () => "provider-wf",
    start: async (input) => {
      redirectUri = input.redirectUri
      return {
        status: "redirect",
        state: "state-123",
        authorizationUrl: "https://provider.test/authorize?state=state-123"
      }
    },
    complete: behaviour.onComplete ?? (async () => connected)
  }
  return { redirectUriUsed: () => redirectUri, auth }
}

const request = {
  integration: "provider",
  connection: "primary",
  authMethod: oauthMethod,
  clientId: "client-id",
  clientSecret: "client-secret"
}

/** Drives the callback the provider would hit, once the flow has announced its
 *  authorization URL (which is when the listener is up). */
const callback = async (
  redirectUri: string,
  query: Record<string, string>
): Promise<Response> => {
  const url = new URL(redirectUri)
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
  return await fetch(url)
}

/** Runs the flow to an `Exit` so a test can assert on the typed failure rather
 *  than on a thrown value, and hands back the announcement so it knows when the
 *  listener is up. `Effect.scoped` is what releases the listener. */
const started = (
  auth: ReturnType<typeof operations>,
  overrides: { readonly timeoutMs?: number } = {}
) => {
  const announced = Promise.withResolvers<string>()
  const exit = Effect.runPromiseExit(Effect.scoped(authorizeInBrowser(
    { ...request, onAuthorizationUrl: (url) => announced.resolve(url), ...overrides },
    auth.auth
  )))
  return { exit, announced: announced.promise }
}

/** The typed failure a flow ended with. */
const failureOf = async (
  exit: Promise<Exit.Exit<Connection, OAuthFlowError>>
): Promise<OAuthFlowError> => {
  const settled = await exit
  if (Exit.isSuccess(settled)) throw new Error("expected the flow to fail")
  const found = Cause.findError(settled.cause)
  if (!Result.isSuccess(found)) throw new Error("the flow died rather than failing")
  return found.success
}

describe("authorizing through the loopback listener", () => {
  test("completes when the provider returns a matching state and code", async () => {
    const auth = operations()
    const { exit, announced } = started(auth)
    await announced

    const page = await callback(auth.redirectUriUsed()!, { state: "state-123", code: "auth-code" })

    expect(page.status).toBe(200)
    expect(await exit).toEqual(Exit.succeed(connected))
  })

  test("refuses a callback whose state does not match the flow", async () => {
    const auth = operations()
    const { exit, announced } = started(auth, { timeoutMs: 1_000 })
    await announced

    const page = await callback(auth.redirectUriUsed()!, { state: "wrong", code: "auth-code" })

    // The page says so, and the flow does not complete — a replayed or forged
    // callback must not connect an account.
    expect(page.status).toBe(400)
    expect(await page.text()).toContain("state could not be verified")
    expect((await failureOf(exit)).stage).toBe("timeout")
  })

  test("fails the flow when the provider returns no code", async () => {
    const auth = operations()
    const { exit, announced } = started(auth)
    await announced

    const page = await callback(auth.redirectUriUsed()!, {
      state: "state-123",
      error_description: "user declined"
    })

    expect(page.status).toBe(400)
    const failure = await failureOf(exit)
    expect(failure.stage).toBe("callback")
    expect(failure.detail).toContain("user declined")
  })

  test("fails the flow when the token exchange is refused", async () => {
    const auth = operations({
      onComplete: async () => {
        throw new Error("token endpoint said no")
      }
    })
    const { exit, announced } = started(auth)
    await announced

    const page = await callback(auth.redirectUriUsed()!, { state: "state-123", code: "auth-code" })

    expect(page.status).toBe(400)
    expect(await page.text()).toContain("token endpoint said no")
    const failure = await failureOf(exit)
    // The stage says which half broke, which the old opaque error could not.
    expect(failure.stage).toBe("exchange")
    expect(failure.detail).toContain("token endpoint said no")
  })

  test("refuses a second callback once one is in flight", async () => {
    const auth = operations()
    const { exit, announced } = started(auth)
    await announced

    await callback(auth.redirectUriUsed()!, { state: "state-123", code: "auth-code" })
    const replay = await callback(auth.redirectUriUsed()!, { state: "state-123", code: "auth-code" })

    expect(replay.status).toBe(409)
    expect(await exit).toEqual(Exit.succeed(connected))
  })

  test("gives up after the timeout rather than holding the listener forever", async () => {
    const auth = operations()
    const { exit, announced } = started(auth, { timeoutMs: 1_000 })
    await announced

    expect((await failureOf(exit)).detail).toContain("timed out after 1 seconds")
  })

  test("stops the listener once the flow settles", async () => {
    const auth = operations()
    const { exit, announced } = started(auth)
    await announced
    const redirectUri = auth.redirectUriUsed()!

    await callback(redirectUri, { state: "state-123", code: "auth-code" })
    await exit

    // The ephemeral port is released; a gateway that leaked one per attempt
    // would run out. Re-binding it is the direct proof — a still-listening
    // server would refuse.
    const port = Number(new URL(redirectUri).port)
    const rebound = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("ok") })
    expect(rebound.port).toBe(port)
    await rebound.stop(true)
  })
})

describe("shutting down while an authorization is in flight", () => {
  test("stop() cancels the flow and releases its listener", async () => {
    let redirectUri: string | undefined
    const auth: OAuthOperations = {
      probe: notUsed("probe"),
      registerClient: notUsed("registerClient"),
      createClient: async () => "provider-wf",
      start: async (input) => {
        redirectUri = input.redirectUri
        return {
          status: "redirect",
          state: "state-123",
          authorizationUrl: "https://provider.test/authorize?state=state-123"
        }
      },
      complete: async () => connected
    }
    const sessions = createOAuthSessions({ auth })

    const session = await Effect.runPromise(sessions.start({
      integration: "provider",
      connection: "primary",
      authMethod: oauthMethod,
      clientId: "client-id",
      clientSecret: "client-secret"
    }))
    expect(session.state.status).toBe("pending")
    const port = Number(new URL(redirectUri!).port)

    await Effect.runPromise(sessions.stop())

    // Before, the flow was a detached `void promise.then(...)`: nothing held it,
    // so a shutdown left the human's browser pointing at a listener the gateway
    // had forgotten. Re-binding the port proves it is really gone.
    const rebound = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("ok") })
    expect(rebound.port).toBe(port)
    await rebound.stop(true)
  })
})
