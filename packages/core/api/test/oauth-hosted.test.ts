import { FetchHttpClient } from "effect/unstable/http"
import { catalogStoreFake, stubHost, stubHostContext } from "./stubs.ts"
import { run, runAll } from "./effect.ts"
import { Context, Effect, Option } from "effect"
import { ConnectionName, IntegrationSlug } from "@integrations/contracts"
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  AuthTemplateSlug,
  CatalogStore,
  IntegrationHost,
  OAuthClientSlug,
  OAuthError,
  OAuthFlows,
  OAuthState
} from "@integrations/host"
import type { OAuthOperations } from "@integrations/gateway-core"
import type { Connection } from "@integrations/contracts"
import { createGatewayHandler, createOAuthSessions, createGatewayStore } from "./gateway.ts"
import type { GatewayStore } from "./gateway.ts"

const directories: Array<string> = []
const stores: Array<GatewayStore> = []

afterEach(async () => {
  await runAll(stores.splice(0).map((store) => store.close()))
  await run(Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  ))
})

const makeStore = async (): Promise<GatewayStore> => {
  const directory = await run(mkdtemp(path.join(tmpdir(), "wf-gateway-oauth-")))
  directories.push(directory)
  const store = await run(createGatewayStore(path.join(directory, "gateway.sqlite")))
  stores.push(store)
  return store
}

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
}

const fakeAuth = (behaviour: {
  readonly completeFails?: boolean
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
      createClient: dies("createClient"),
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
          expiresAt: Option.none()
        })
      },
      accessToken: dies("accessToken")
    }),
    Context.add(CatalogStore, catalogStoreFake()),
    Context.add(IntegrationHost, stubHost({ refreshConnection: () => Effect.succeed([]) }))
  )
  return { record, host }
}

describe("hosted oauth flows", () => {
  test("registers against the public URL instead of a loopback port", async () => {
    const fake = fakeAuth()
    const sessions = createOAuthSessions(fake.host, {
      publicUrl: "https://gw.example.com"
    })

    const session = await run(sessions.start({
      integration: "google",
      connection: "default",
      authMethod: oauthMethod
    }))

    expect(fake.record.redirectUri).toBe("https://gw.example.com/v1/oauth/callback")
    expect(session.state.status).toBe("pending")
    if (session.state.status !== "pending") return
    expect(session.state.authorizationUrl).toContain("accounts.example")
  })

  test("completes by provider state exactly once", async () => {
    const fake = fakeAuth()
    const completed: Array<string> = []
    const sessions = createOAuthSessions(fake.host, {
      publicUrl: "https://gw.example.com",
      onConnected: async (session) => {
        completed.push(session.id)
      }
    })
    await run(sessions.start({
      integration: "google",
      connection: "default",
      authMethod: oauthMethod
    }))

    const done = await run(sessions.completeByState("provider-state-1", { code: "abc" }))
    expect(done?.state.status).toBe("connected")
    if (done === undefined) throw new Error("Expected OAuth completion")
    expect(fake.record.completedState).toBe("provider-state-1")
    expect(fake.record.completedCode).toBe("abc")
    expect(completed).toEqual([done.id])

    expect(await run(sessions.completeByState("provider-state-1", { code: "abc" }))).toBeUndefined()
    expect(completed).toEqual([done.id])
    expect(await run(sessions.completeByState("never-seen", { code: "abc" }))).toBeUndefined()
  })

  test("records the failure on the session when the exchange is refused", async () => {
    const fake = fakeAuth({ completeFails: true })
    const sessions = createOAuthSessions(fake.host, {
      publicUrl: "https://gw.example.com"
    })
    await run(sessions.start({
      integration: "google",
      connection: "default",
      authMethod: oauthMethod
    }))

    const failed = await run(sessions.completeByState("provider-state-1", { code: "bad" }))
    expect(failed?.state.status).toBe("failed")
    if (failed?.state.status !== "failed") return
    expect(failed.state.message).toContain("token exchange rejected")
  })

  test("local mode still owns an ephemeral listener and needs no public URL", async () => {
    const fake = fakeAuth()
    const sessions = createOAuthSessions(fake.host)
    const session = await run(sessions.start({
      integration: "google",
      connection: "default",
      authMethod: oauthMethod
    }))
    expect(fake.record.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/)
    expect(session.state.status).toBe("pending")
    await run(sessions.stop())
  })
})



describe("the hosted callback route", () => {

  const setup = async (
    oauthSessions: Parameters<typeof createGatewayHandler>[0]["oauth"]
  ) => {
    const store = await run(makeStore())
    const { handle } = createGatewayHandler({
    httpClient: FetchHttpClient.layer,
      hostServices: stubHostContext(),
      store,
      retentionDays: 30,
      oauth: oauthSessions
    })
    return async (pathname: string) => {
      const response = await run(handle(new Request(`http://gateway.test${pathname}`)))
      const text = await run(response.text())
      return { status: response.status, text }
    }
  }

  test("connects when the state is known and shows the human a page", async () => {
    let completed: { state?: string; code?: string } | undefined
    const call = await run(setup({
      start: () => Effect.die(new Error("not used")),
      get: () => Effect.sync((): undefined => undefined),
      stop: () => Effect.void,
      completeByState: (state, input) => Effect.sync(() => {
        completed = { state, code: input.code }
        return {
          id: "s1",
          integration: "google",
          connection: "default",
          state: { status: "connected", connection: connection("default") }
        }
      })
    }))

    const response = await run(call("/v1/oauth/callback?state=provider-state-1&code=abc"))
    expect(response.status).toBe(200)
    expect(response.text).toContain("Account connected")
    expect(completed?.code).toBe("abc")
  })

  test("answers an unknown or error callback with a readable page, not JSON", async () => {
    const unknownCall = await run(setup({
      start: () => Effect.die(new Error("not used")),
      get: () => Effect.sync((): undefined => undefined),
      stop: () => Effect.void,
      completeByState: () => Effect.sync((): undefined => undefined)
    }))
    const unknown = await run(unknownCall("/v1/oauth/callback?state=stale&code=abc"))
    expect(unknown.status).toBe(400)
    expect(unknown.text).toContain("Unknown authorization")

    const erroredCall = await run(setup({
      start: () => Effect.die(new Error("not used")),
      get: () => Effect.sync((): undefined => undefined),
      stop: () => Effect.void,
      completeByState: () => Effect.sync((): undefined => undefined)
    }))
    const errored = await run(erroredCall(
      "/v1/oauth/callback?state=provider-state-1&error=access_denied&error_description=User%20declined"
    ))
    expect(errored.status).toBe(400)
    expect(errored.text).toContain("User declined")
  })

  test("reports a flow that failed during completion", async () => {
    const call = await run(setup({
      start: () => Effect.die(new Error("not used")),
      get: () => Effect.sync((): undefined => undefined),
      stop: () => Effect.void,
      completeByState: () => Effect.succeed({
        id: "s1",
        integration: "google",
        connection: "default",
        state: { status: "failed", message: "token exchange rejected" }
      })
    }))
    const response = await run(call("/v1/oauth/callback?state=provider-state-1&code=abc"))
    expect(response.status).toBe(400)
    expect(response.text).toContain("token exchange rejected")
  })
})
