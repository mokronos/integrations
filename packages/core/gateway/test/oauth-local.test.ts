import { describe, expect, it } from "@effect/vitest"
import type { AuthMethod, Connection } from "@integrations/contracts"
import { ConnectionName, IntegrationSlug } from "@integrations/contracts"
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, Option, Result } from "effect"
import { TestClock } from "effect/testing"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import {
  AuthTemplateSlug,
  CatalogStore,
  Integrations,
  OAuthClientSlug,
  OAuthError,
  OAuthFlows,
  OAuthState
} from "@integrations/integrations"
import { authorizeInBrowser, OAuthFlowError } from "../src/oauth.ts"
import { createOAuthSessions } from "../src/oauth-sessions.ts"
import type { OAuthOperations } from "../src/oauth.ts"
import { testServices } from "./fixtures.ts"

const services = Layer.merge(testServices, FetchHttpClient.layer)

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

const integrations: Integrations["Service"] = {
  refreshConnection: () => Effect.succeed([]),
  listIntegrations: notUsed("Integrations.listIntegrations"),
  findIntegration: notUsed("Integrations.findIntegration"),
  addMcp: notUsed("Integrations.addMcp"),
  addOpenApi: notUsed("Integrations.addOpenApi"),
  renameIntegration: notUsed("Integrations.renameIntegration"),
  removeIntegration: notUsed("Integrations.removeIntegration"),
  createConnection: notUsed("Integrations.createConnection"),
  listConnections: notUsed("Integrations.listConnections"),
  removeConnection: notUsed("Integrations.removeConnection"),
  toolSummaries: notUsed("Integrations.toolSummaries"),
  listTools: notUsed("Integrations.listTools"),
  describeTool: notUsed("Integrations.describeTool"),
  execute: notUsed("Integrations.execute")
}

const operations = (behaviour: { readonly completeFails?: string } = {}) => {
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
          : Effect.fail(new OAuthError({ stage: "complete", detail: behaviour.completeFails })),
      accessToken: notUsed("accessToken")
    }),
    Context.add(CatalogStore, catalogStore),
    Context.add(Integrations, integrations)
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

/**
 * The flow only settles once a browser reaches its loopback listener, so it
 * runs on its own fiber and announces the URL the provider would redirect to.
 */
const started = Effect.fnUntraced(function*(
  auth: ReturnType<typeof operations>,
  overrides: { readonly timeoutMs?: number } = {}
) {
  const announced = yield* Deferred.make<string>()
  const fiber = yield* Effect.forkChild(Effect.scoped(authorizeInBrowser({
    ...request,
    onAuthorizationUrl: (url) => Deferred.doneUnsafe(announced, Exit.succeed(url)),
    ...overrides
  }).pipe(Effect.provide(auth.host))))
  yield* Deferred.await(announced)
  const redirectUri = auth.redirectUriUsed()
  if (redirectUri === undefined) throw new Error("the flow announced no redirect URI")
  return { fiber, redirectUri }
})

/** The request a browser would make when the provider redirects it back. */
const callback = (redirectUri: string, query: Record<string, string>) => {
  const url = new URL(redirectUri)
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
  return HttpClient.get(url)
}

/** The typed failure the flow ended with, insisting it failed rather than died. */
const failureOf = <A>(
  fiber: Fiber.Fiber<A, OAuthFlowError>
): Effect.Effect<OAuthFlowError> =>
  Effect.flatMap(Fiber.await(fiber), (settled) => {
    if (Exit.isSuccess(settled)) throw new Error("expected the flow to fail")
    const found = Cause.findError(settled.cause)
    if (!Result.isSuccess(found)) throw new Error("the flow died rather than failing")
    return Effect.succeed(found.success)
  })

/** Whether the port the listener held can be taken over again. */
const portIsFree = (redirectUri: string): Effect.Effect<boolean> =>
  Effect.sync(() => {
    const port = Number(new URL(redirectUri).port)
    const rebound = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("ok") })
    const reclaimed = rebound.port === port
    rebound.stop(true)
    return reclaimed
  })

describe("authorizing through the loopback listener", () => {
  it.live("completes when the provider returns a matching state and code", () =>
    Effect.gen(function*() {
      const auth = operations()
      const { fiber, redirectUri } = yield* started(auth)

      const page = yield* callback(redirectUri, { state: "state-123", code: "auth-code" })

      expect(page.status).toBe(200)
      expect(yield* Fiber.join(fiber)).toEqual(connected)
    }).pipe(Effect.provide(services)))

  it.live("refuses a callback whose state does not match the flow", () =>
    Effect.gen(function*() {
      const auth = operations()
      const { fiber, redirectUri } = yield* started(auth, { timeoutMs: 1_000 })

      const page = yield* callback(redirectUri, { state: "wrong", code: "auth-code" })

      expect(page.status).toBe(400)
      expect(yield* page.text).toContain("state could not be verified")
      expect((yield* failureOf(fiber)).stage).toBe("timeout")
    }).pipe(Effect.provide(services)))

  it.live("fails the flow when the provider returns no code", () =>
    Effect.gen(function*() {
      const auth = operations()
      const { fiber, redirectUri } = yield* started(auth)

      const page = yield* callback(redirectUri, {
        state: "state-123",
        error_description: "user declined"
      })

      expect(page.status).toBe(400)
      const failure = yield* failureOf(fiber)
      expect(failure.stage).toBe("callback")
      expect(failure.detail).toContain("user declined")
    }).pipe(Effect.provide(services)))

  it.live("fails the flow when the token exchange is refused", () =>
    Effect.gen(function*() {
      const auth = operations({ completeFails: "token endpoint said no" })
      const { fiber, redirectUri } = yield* started(auth)

      const page = yield* callback(redirectUri, { state: "state-123", code: "auth-code" })

      expect(page.status).toBe(400)
      expect(yield* page.text).toContain("token endpoint said no")
      const failure = yield* failureOf(fiber)
      expect(failure.stage).toBe("exchange")
      expect(failure.detail).toContain("token endpoint said no")
    }).pipe(Effect.provide(services)))

  it.live("refuses a second callback once one is in flight", () =>
    Effect.gen(function*() {
      const auth = operations()
      const { fiber, redirectUri } = yield* started(auth)

      yield* callback(redirectUri, { state: "state-123", code: "auth-code" })
      const replay = yield* callback(redirectUri, { state: "state-123", code: "auth-code" })

      expect(replay.status).toBe(409)
      expect(yield* Fiber.join(fiber)).toEqual(connected)
    }).pipe(Effect.provide(services)))

  it.effect("gives up after the timeout rather than holding the listener forever", () =>
    Effect.gen(function*() {
      const auth = operations()
      const { fiber } = yield* started(auth, { timeoutMs: 1_000 })

      yield* TestClock.adjust("1 second")

      expect((yield* failureOf(fiber)).detail).toContain("timed out after 1 seconds")
    }).pipe(Effect.provide(services)))

  it.live("stops the listener once the flow settles", () =>
    Effect.gen(function*() {
      const auth = operations()
      const { fiber, redirectUri } = yield* started(auth)

      yield* callback(redirectUri, { state: "state-123", code: "auth-code" })
      yield* Fiber.await(fiber)

      expect(yield* portIsFree(redirectUri)).toBe(true)
    }).pipe(Effect.provide(services)))
})

describe("shutting down while an authorization is in flight", () => {
  it.live("stop() cancels the flow and releases its listener", () =>
    Effect.gen(function*() {
      const auth = operations()
      const sessions = createOAuthSessions(auth.host)

      const session = yield* sessions.start({
        integration: "provider",
        connection: "primary",
        authMethod: oauthMethod,
        clientId: "client-id",
        clientSecret: "client-secret"
      })
      expect(session.state.status).toBe("pending")
      const redirectUri = auth.redirectUriUsed()
      if (redirectUri === undefined) throw new Error("the session announced no redirect URI")

      yield* sessions.stop()

      expect(yield* portIsFree(redirectUri)).toBe(true)
    }).pipe(Effect.provide(services)))
})
