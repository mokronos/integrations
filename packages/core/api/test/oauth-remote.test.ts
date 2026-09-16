import { describe, expect, it } from "@effect/vitest"
import { Context, Effect, Option } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { ConnectionName, IntegrationSlug, whenPresent } from "@integrations/contracts"
import { catalogStoreFake, stubIntegrations, stubIntegrationsContext } from "./stubs.ts"
import { gatewayStore, testServices } from "./fixtures.ts"
import {
  AuthTemplateSlug,
  CatalogStore,
  Integrations,
  OAuthClientSlug,
  OAuthError,
  OAuthFlows,
  OAuthState
} from "@integrations/integrations"
import type { OAuthClientRecord } from "@integrations/integrations"
import type { OAuthOperations } from "@integrations/gateway-core"
import type { Connection } from "@integrations/contracts"
import { createGatewayHandler, createOAuthSessions } from "./gateway.ts"

const oauthMethod = {
  id: "google-oauth",
  label: "Google",
  kind: "oauth",
  template: "google",
  oauth: {
    authorizationUrl: "https://accounts.example/authorize",
    tokenUrl: "https://oauth2.example/token",
    registrationEndpoint: "https://oauth2.example/register"
  }
} as const

const connection = (name: string): Connection => ({
  owner: "org",
  name: ConnectionName.make(name),
  integration: IntegrationSlug.make("google"),
  template: "google",
  address: `connections.google.org.${name}`,
  provider: "google",
  status: "connected"
})

interface RecordedFlow {
  redirectUri: string
  completedState?: string
  completedCode?: string
  createdClientId?: string
}

const fakeAuth = (behaviour: {
  readonly completeFails?: boolean
  readonly storedClient?: OAuthClientRecord
} = {}) => {
  const record: RecordedFlow = { redirectUri: "(none)" }
  let started = false
  const dies = (member: string) => () =>
    Effect.die(new Error(`${member} is not used by these tests`))

  const host: Context.Context<OAuthOperations> = Context.empty().pipe(
    Context.add(OAuthFlows, {
      probe: dies("probe"),
      registerDynamicClient: (options) => {
        record.redirectUri = options.redirectUri
        return Effect.succeed(OAuthClientSlug.make(`client-${options.slug}`))
      },
      createClient: (options) => {
        record.createdClientId = options.clientId
        return Effect.succeed(options.slug)
      },
      start: () => {
        if (started) return Effect.die(new Error("start called twice"))
        started = true
        return Effect.succeed({
          authorizationUrl: "https://accounts.example/authorize?state=provider-state-1",
          state: OAuthState.make("provider-state-1")
        })
      },
      complete: (options) => {
        if (behaviour.completeFails === true) {
          return Effect.fail(new OAuthError({
            stage: "complete",
            detail: "token exchange rejected"
          }))
        }
        record.completedState = options.state
        record.completedCode = options.code
        return Effect.succeed({
          owner: "org" as const,
          integration: IntegrationSlug.make("google"),
          connection: ConnectionName.make("default"),
          template: AuthTemplateSlug.make("google"),
          clientOwner: "org" as const,
          client: OAuthClientSlug.make("client-google-wf"),
          scope: Option.none(),
          expiresAt: Option.none(),
          renewable: true
        })
      },
      accessToken: dies("accessToken")
    }),
    Context.add(
      CatalogStore,
      catalogStoreFake({
        findOAuthClient: () => Effect.succeed(Option.fromNullishOr(behaviour.storedClient))
      })
    ),
    Context.add(Integrations, stubIntegrations({ refreshConnection: () => Effect.succeed([]) }))
  )
  return { record, host }
}

describe("remote oauth flows", () => {
  const remote = (fake: ReturnType<typeof fakeAuth>, options: {
    readonly onConnected?: (session: { readonly id: string }) => Promise<void>
  } = {}) =>
    createOAuthSessions(fake.host, {
      publicUrl: "https://gw.example.com",
      ...whenPresent("onConnected", options.onConnected)
    })

  const startGoogle = { integration: "google", connection: "default", authMethod: oauthMethod }

  /** A provider like Google: no dynamic registration, so a human must register an app. */
  const manualMethod = {
    ...oauthMethod,
    oauth: {
      authorizationUrl: oauthMethod.oauth.authorizationUrl,
      tokenUrl: oauthMethod.oauth.tokenUrl
    }
  } as const
  const startManual = { integration: "google", connection: "default", authMethod: manualMethod }

  const storedClient = {
    owner: "org" as const,
    slug: OAuthClientSlug.make("google-wf"),
    integration: IntegrationSlug.make("google"),
    clientId: "already-registered",
    authorizationUrl: manualMethod.oauth.authorizationUrl,
    tokenUrl: manualMethod.oauth.tokenUrl,
    scopes: [],
    tokenAuthMethods: []
  }

  it.effect("parks the session for a human when the provider needs an app of its own", () =>
    Effect.gen(function*() {
      const fake = fakeAuth()

      const session = yield* remote(fake).start(startManual)

      expect(session.state.status).toBe("needs-client")
      if (session.state.status !== "needs-client") return
      expect(session.state.setupUrl).toBe(
        `https://gw.example.com/integrations?setup=${session.id}`
      )
      expect(session.state.guidance).toContain("does not support dynamic client registration")
      expect(session.state.guidance).toContain("https://gw.example.com/v1/oauth/callback")
    }))

  it.effect("resumes a parked session once a human supplies the client", () =>
    Effect.gen(function*() {
      const fake = fakeAuth()
      const sessions = remote(fake)
      const parked = yield* sessions.start(startManual)

      const resumed = yield* sessions.provideClient(parked.id, {
        clientId: "typed-by-a-human",
        clientSecret: "secret-from-the-browser"
      })

      expect(fake.record.createdClientId).toBe("typed-by-a-human")
      expect(resumed?.id).toBe(parked.id)
      expect(resumed?.state.status).toBe("pending")
    }))

  it.effect("keeps the client secret out of the stored session", () =>
    Effect.gen(function*() {
      const fake = fakeAuth()
      const sessions = remote(fake)
      const parked = yield* sessions.start(startManual)

      yield* sessions.provideClient(parked.id, {
        clientId: "typed-by-a-human",
        clientSecret: "secret-from-the-browser"
      })

      const stored = yield* sessions.get(parked.id)
      expect(JSON.stringify(stored)).not.toContain("secret-from-the-browser")
    }))

  it.effect("ignores a client for a session that is not waiting for one", () =>
    Effect.gen(function*() {
      const fake = fakeAuth()
      const sessions = remote(fake)
      const pending = yield* sessions.start(startGoogle)

      const resumed = yield* sessions.provideClient(pending.id, { clientId: "too-late" })

      expect(resumed).toBeUndefined()
    }))

  it.effect("reuses an OAuth client a human already registered", () =>
    Effect.gen(function*() {
      const fake = fakeAuth({ storedClient })

      const session = yield* remote(fake).start(startManual)

      expect(session.state.status).toBe("pending")
      expect(fake.record.createdClientId).toBeUndefined()
    }))

  it.effect("registers against the public URL instead of a loopback port", () =>
    Effect.gen(function*() {
      const fake = fakeAuth()

      const session = yield* remote(fake).start(startGoogle)

      expect(fake.record.redirectUri).toBe("https://gw.example.com/v1/oauth/callback")
      expect(session.state.status).toBe("pending")
      if (session.state.status !== "pending") return
      expect(session.state.authorizationUrl).toContain("accounts.example")
    }))

  it.effect("completes by provider state exactly once", () =>
    Effect.gen(function*() {
      const fake = fakeAuth()
      const completed: Array<string> = []
      const sessions = remote(fake, {
        onConnected: async (session) => void completed.push(session.id)
      })
      yield* sessions.start(startGoogle)

      const done = yield* sessions.completeByState("provider-state-1", { code: "abc" })

      expect(done?.state.status).toBe("connected")
      if (done === undefined) throw new Error("Expected OAuth completion")
      expect(fake.record.completedState).toBe("provider-state-1")
      expect(fake.record.completedCode).toBe("abc")
      expect(completed).toEqual([done.id])

      expect(yield* sessions.completeByState("provider-state-1", { code: "abc" })).toBeUndefined()
      expect(completed).toEqual([done.id])
      expect(yield* sessions.completeByState("never-seen", { code: "abc" })).toBeUndefined()
    }))

  it.effect("records the failure on the session when the exchange is refused", () =>
    Effect.gen(function*() {
      const sessions = remote(fakeAuth({ completeFails: true }))
      yield* sessions.start(startGoogle)

      const failed = yield* sessions.completeByState("provider-state-1", { code: "bad" })

      expect(failed?.state.status).toBe("failed")
      if (failed?.state.status !== "failed") return
      expect(failed.state.message).toContain("token exchange rejected")
    }))

  it.effect("local mode still owns an ephemeral listener and needs no public URL", () =>
    Effect.gen(function*() {
      const fake = fakeAuth()
      const sessions = createOAuthSessions(fake.host)

      const session = yield* sessions.start(startGoogle)

      expect(fake.record.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/)
      expect(session.state.status).toBe("pending")
      yield* sessions.stop()
    }))
})

describe("the remote callback route", () => {
  const notUsed = {
    start: () => Effect.die(new Error("not used")),
    provideClient: () => Effect.sync((): undefined => undefined),
    get: () => Effect.sync((): undefined => undefined),
    stop: () => Effect.void
  }

  const request = {
    integration: "google",
    connection: "default",
    authMethod: {
      id: "googleOAuth2",
      label: "Google",
      kind: "oauth" as const,
      template: "google"
    }
  }

  /** A browser arriving at the callback route, and the page it is shown. */
  const callbacks = Effect.fnUntraced(function*(
    oauth: Parameters<typeof createGatewayHandler>[0]["oauth"]
  ) {
    const store = yield* gatewayStore("gateway-oauth-")
    const { handle } = createGatewayHandler({
      httpClient: FetchHttpClient.layer,
      integrationServices: stubIntegrationsContext(),
      store,
      retentionDays: 30,
      oauth
    })
    return Effect.fnUntraced(function*(pathname: string) {
      const response = yield* Effect.promise(() =>
        handle(new Request(`http://gateway.test${pathname}`)))
      return { status: response.status, text: yield* Effect.promise(() => response.text()) }
    })
  })

  it.effect("connects when the state is known and shows the human a page", () =>
    Effect.gen(function*() {
      let completed: { state?: string; code?: string } | undefined
      const call = yield* callbacks({
        ...notUsed,
        completeByState: (state, input) => Effect.sync(() => {
          completed = { state, code: input.code }
          return {
            id: "s1",
            integration: "google",
            connection: "default",
            request,
            state: { status: "connected", connection: connection("default") }
          }
        })
      })

      const response = yield* call("/v1/oauth/callback?state=provider-state-1&code=abc")

      expect(response.status).toBe(200)
      expect(response.text).toContain("Account connected")
      expect(completed?.code).toBe("abc")
    }).pipe(Effect.provide(testServices)))

  it.effect("answers an unknown or error callback with a readable page, not JSON", () =>
    Effect.gen(function*() {
      const call = yield* callbacks({
        ...notUsed,
        completeByState: () => Effect.sync((): undefined => undefined)
      })

      const unknown = yield* call("/v1/oauth/callback?state=stale&code=abc")
      expect(unknown.status).toBe(400)
      expect(unknown.text).toContain("Unknown authorization")

      const errored = yield* call(
        "/v1/oauth/callback?state=provider-state-1&error=access_denied&error_description=User%20declined"
      )
      expect(errored.status).toBe(400)
      expect(errored.text).toContain("User declined")
    }).pipe(Effect.provide(testServices)))

  it.effect("reports a flow that failed during completion", () =>
    Effect.gen(function*() {
      const call = yield* callbacks({
        ...notUsed,
        completeByState: () => Effect.succeed({
          id: "s1",
          integration: "google",
          connection: "default",
          request,
          state: { status: "failed", message: "token exchange rejected" }
        })
      })

      const response = yield* call("/v1/oauth/callback?state=provider-state-1&code=abc")

      expect(response.status).toBe(400)
      expect(response.text).toContain("token exchange rejected")
    }).pipe(Effect.provide(testServices)))
})
