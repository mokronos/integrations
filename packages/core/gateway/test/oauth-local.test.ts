import { describe, expect, test } from "bun:test"
import type { AuthMethod, Connection } from "@integrations/contracts"
import { ConnectionName, IntegrationSlug } from "@integrations/contracts"
import { Cause, Context, Effect, Exit, Option, Result } from "effect"
import { FetchHttpClient, HttpClient, type HttpClientResponse } from "effect/unstable/http"
import {
  AuthTemplateSlug,
  CatalogStore,
  IntegrationHost,
  OAuthClientSlug,
  OAuthError,
  OAuthFlows,
  OAuthState
} from "@integrations/integrations"
import { authorizeInBrowser, OAuthFlowError } from "../src/oauth.ts"
import { createOAuthSessions } from "../src/oauth-sessions.ts"
import type { OAuthOperations } from "../src/oauth.ts"

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
  address: "tools.provider.org.primary",
  provider: "oauth",
  oauthClient: "provider-wf",
  oauthClientOwner: "org",
  oauthScope: null,
  expiresAt: null,
  missingOAuthScopes: [],
  status: "connected"
}

const notUsed = (member: string) => () =>
  Effect.die(new Error(`${member} is not used by these tests`))

const catalogStore: CatalogStore["Service"] = {
  putConnection: () => Effect.void,
  listIntegrations: notUsed("CatalogStore.listIntegrations"),
  findIntegration: notUsed("CatalogStore.findIntegration"),
  putIntegration: notUsed("CatalogStore.putIntegration"),
  renameIntegration: notUsed("CatalogStore.renameIntegration"),
  removeIntegration: notUsed("CatalogStore.removeIntegration"),
  listConnections: notUsed("CatalogStore.listConnections"),
  removeConnection: notUsed("CatalogStore.removeConnection"),
  findOAuthClient: notUsed("CatalogStore.findOAuthClient"),
  putOAuthClient: notUsed("CatalogStore.putOAuthClient"),
  putOAuthFlow: notUsed("CatalogStore.putOAuthFlow"),
  takeOAuthFlow: notUsed("CatalogStore.takeOAuthFlow"),
  listTools: notUsed("CatalogStore.listTools"),
  findTool: notUsed("CatalogStore.findTool"),
  replaceTools: notUsed("CatalogStore.replaceTools"),
  findSpecDocument: notUsed("CatalogStore.findSpecDocument"),
  putSpecDocument: notUsed("CatalogStore.putSpecDocument")
}

const integrationHost: IntegrationHost["Service"] = {
  refreshConnection: () => Effect.succeed([]),
  listIntegrations: notUsed("IntegrationHost.listIntegrations"),
  findIntegration: notUsed("IntegrationHost.findIntegration"),
  addMcp: notUsed("IntegrationHost.addMcp"),
  addOpenApi: notUsed("IntegrationHost.addOpenApi"),
  renameIntegration: notUsed("IntegrationHost.renameIntegration"),
  removeIntegration: notUsed("IntegrationHost.removeIntegration"),
  createConnection: notUsed("IntegrationHost.createConnection"),
  listConnections: notUsed("IntegrationHost.listConnections"),
  removeConnection: notUsed("IntegrationHost.removeConnection"),
  toolSummaries: notUsed("IntegrationHost.toolSummaries"),
  listTools: notUsed("IntegrationHost.listTools"),
  describeTool: notUsed("IntegrationHost.describeTool"),
  execute: notUsed("IntegrationHost.execute")
}

const operations = (behaviour: {
  readonly completeFails?: string
} = {}) => {
  let redirectUri: string | undefined
  const host: Context.Context<OAuthOperations> = Context.empty().pipe(
    Context.add(OAuthFlows, {
      probe: notUsed("probe"),
      registerDynamicClient: notUsed("registerDynamicClient"),
      createClient: () => Effect.succeed(OAuthClientSlug.make("provider-wf")),
      start: (options) => {
        redirectUri = options.redirectUri
        return Effect.succeed({
          authorizationUrl: "https://provider.test/authorize?state=state-123",
          state: OAuthState.make("state-123")
        })
      },
      complete: () =>
        behaviour.completeFails === undefined
          ? Effect.succeed({
            owner: "org" as const,
            integration: IntegrationSlug.make("provider"),
            connection: ConnectionName.make("primary"),
            template: AuthTemplateSlug.make("oauth"),
            clientOwner: "org" as const,
            client: OAuthClientSlug.make("provider-wf"),
            scope: Option.none(),
            expiresAt: Option.none()
          })
          : Effect.fail(new OAuthError({
            stage: "complete",
            detail: behaviour.completeFails
          })),
      accessToken: notUsed("accessToken")
    }),
    Context.add(CatalogStore, catalogStore),
    Context.add(IntegrationHost, integrationHost)
  )
  return { redirectUriUsed: () => redirectUri, host }
}

const request = {
  integration: "provider",
  connection: "primary",
  authMethod: oauthMethod,
  clientId: "client-id",
  clientSecret: "client-secret"
}

const callback = (
  redirectUri: string,
  query: Record<string, string>
): Promise<HttpClientResponse.HttpClientResponse> => {
  const url = new URL(redirectUri)
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
  return Effect.runPromise(
    HttpClient.get(url).pipe(Effect.provide(FetchHttpClient.layer))
  )
}

const started = (
  auth: ReturnType<typeof operations>,
  overrides: { readonly timeoutMs?: number } = {}
) => {
  const announced = Promise.withResolvers<string>()
  const exit = Effect.runPromiseExit(Effect.scoped(authorizeInBrowser(
    { ...request, onAuthorizationUrl: (url) => announced.resolve(url), ...overrides }
  ).pipe(Effect.provide(auth.host))))
  return { exit, announced: announced.promise }
}

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

    expect(page.status).toBe(400)
    expect(await Effect.runPromise(page.text)).toContain("state could not be verified")
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
    const auth = operations({ completeFails: "token endpoint said no" })
    const { exit, announced } = started(auth)
    await announced

    const page = await callback(auth.redirectUriUsed()!, { state: "state-123", code: "auth-code" })

    expect(page.status).toBe(400)
    expect(await Effect.runPromise(page.text)).toContain("token endpoint said no")
    const failure = await failureOf(exit)
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

    const port = Number(new URL(redirectUri).port)
    const rebound = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("ok") })
    expect(rebound.port).toBe(port)
    await rebound.stop(true)
  })
})

describe("shutting down while an authorization is in flight", () => {
  test("stop() cancels the flow and releases its listener", async () => {
    const auth = operations()
    const sessions = createOAuthSessions(auth.host)

    const session = await Effect.runPromise(sessions.start({
      integration: "provider",
      connection: "primary",
      authMethod: oauthMethod,
      clientId: "client-id",
      clientSecret: "client-secret"
    }))
    expect(session.state.status).toBe("pending")
    const port = Number(new URL(auth.redirectUriUsed()!).port)

    await Effect.runPromise(sessions.stop())

    const rebound = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("ok") })
    expect(rebound.port).toBe(port)
    await rebound.stop(true)
  })
})
