import { run, runAll } from "./effect.ts"
import { Effect } from "effect"
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { AuthApi, IntegrationsApi } from "@mokronos/integrations"
import type { Connection } from "@mokronos/contracts"
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
  name,
  integration: "google",
  template: "google",
  address: `connections.google.org.${name}`,
  provider: "google"
})

interface RecordedFlow {
  redirectUri: string
  completedState?: string
  completedCode?: string
}

/** A stand-in for the integrations's OAuth operations. It records the redirect URI
 *  a flow was registered with — that is the whole point of hosted mode — and
 *  answers completions with a canned connection. */
const fakeAuth = (behaviour: {
  readonly completeFails?: boolean
} = {}) => {
  const record: RecordedFlow = { redirectUri: "(none)" }
  let started = false
  const auth: Pick<AuthApi, "probe" | "registerClient" | "createClient" | "start" | "complete"> = {
    probe: async () => {
      throw new Error("probe is not used when endpoints are explicit")
    },
    registerClient: async (options) => {
      record.redirectUri = options.redirectUri
      return `client-${options.slug}`
    },
    createClient: async () => {
      throw new Error("createClient is not used without --client-id")
    },
    start: async () => {
      if (started) throw new Error("start called twice")
      started = true
      return {
        status: "redirect",
        state: "provider-state-1",
        authorizationUrl: "https://accounts.example/authorize?state=provider-state-1"
      }
    },
    complete: async (options) => {
      if (behaviour.completeFails === true) throw new Error("token exchange rejected")
      record.completedState = options.state
      record.completedCode = options.code
      return connection("default")
    }
  }
  return { record, auth }
}

describe("hosted oauth flows", () => {
  test("registers against the public URL instead of a loopback port", async () => {
    const fake = fakeAuth()
    const sessions = createOAuthSessions({ auth: fake.auth }, {
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
    const sessions = createOAuthSessions({ auth: fake.auth }, {
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

    // A replayed callback is consumed, not a second connection.
    expect(await run(sessions.completeByState("provider-state-1", { code: "abc" }))).toBeUndefined()
    expect(completed).toEqual([done.id])
    expect(await run(sessions.completeByState("never-seen", { code: "abc" }))).toBeUndefined()
  })

  test("records the failure on the session when the exchange is refused", async () => {
    const fake = fakeAuth({ completeFails: true })
    const sessions = createOAuthSessions({ auth: fake.auth }, {
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
    const sessions = createOAuthSessions({ auth: fake.auth })
    const session = await run(sessions.start({
      integration: "google",
      connection: "default",
      authMethod: oauthMethod
    }))
    // The flow was registered against some 127.0.0.1 port this process bound.
    expect(fake.record.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/)
    expect(session.state.status).toBe("pending")
    await run(sessions.stop())
  })
})


const notStubbed = (member: string) => () => {
  throw new Error(`stubIntegrations: ${member} is not stubbed for these tests`)
}

/** A throwing stand-in for the whole integrations surface. The callback route
 *  never reaches any of these members; a partial fake that returned undefined
 *  would let a handler quietly start depending on one. */
const stubIntegrations = (): IntegrationsApi => ({
  tools: {
    execute: notStubbed("tools.execute"),
    summaries: async () => [],
    describe: notStubbed("tools.describe"),
    list: async () => []
  },
  connections: {
    list: async () => [],
    remove: notStubbed("connections.remove"),
    create: notStubbed("connections.create"),
    ensure: notStubbed("connections.ensure")
  },
  catalog: {
    classify: notStubbed("catalog.classify"),
    list: notStubbed("catalog.list"),
    find: notStubbed("catalog.find"),
    addMcp: notStubbed("catalog.addMcp"),
    addOpenApi: notStubbed("catalog.addOpenApi"),
    remove: notStubbed("catalog.remove")
  },
  auth: {
    probe: notStubbed("auth.probe"),
    registerClient: notStubbed("auth.registerClient"),
    createClient: notStubbed("auth.createClient"),
    start: notStubbed("auth.start"),
    complete: notStubbed("auth.complete")
  },
  provisioning: {
    install: notStubbed("provisioning.install"),
    provision: notStubbed("provisioning.provision")
  },
  validateIntegrationNode: notStubbed("validateIntegrationNode"),
  listIntegrationOverviews: async () => []
})

describe("the hosted callback route", () => {

  const setup = async (
    oauthSessions: Parameters<typeof createGatewayHandler>[0]["oauth"]
  ) => {
    const store = await run(makeStore())
    const { handle } = createGatewayHandler({
      store,
      integrations: stubIntegrations(),
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
