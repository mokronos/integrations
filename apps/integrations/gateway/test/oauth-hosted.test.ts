import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ExecutorAuth, ExecutorConnection, ExecutorServices } from "@mokronos/integrations-executor"
import {
  createGatewayHandler,
  createOAuthSessions,
  gatewayRoutes,
  createGatewayStore
} from "../src/index.ts"
import type { GatewayStore } from "../src/index.ts"

const directories: Array<string> = []
const stores: Array<GatewayStore> = []

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()))
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

const makeStore = async (): Promise<GatewayStore> => {
  const directory = await mkdtemp(path.join(tmpdir(), "wf-gateway-oauth-"))
  directories.push(directory)
  const store = await createGatewayStore(path.join(directory, "gateway.sqlite"))
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

const connection = (name: string): ExecutorConnection => ({
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

/** A stand-in for the executor's OAuth operations. It records the redirect URI
 *  a flow was registered with — that is the whole point of hosted mode — and
 *  answers completions with a canned connection. */
const fakeAuth = (behaviour: {
  readonly completeFails?: boolean
} = {}) => {
  const record: RecordedFlow = { redirectUri: "(none)" }
  let started = false
  const auth: Pick<ExecutorAuth, "probe" | "registerClient" | "createClient" | "start" | "complete"> = {
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

    const session = await sessions.start({
      integration: "google",
      connection: "default",
      authMethod: oauthMethod
    })

    expect(fake.record.redirectUri).toBe("https://gw.example.com/v1/oauth/callback")
    expect(session.state.status).toBe("pending")
    if (session.state.status !== "pending") return
    expect(session.state.authorizationUrl).toContain("accounts.example")
  })

  test("completes by provider state exactly once", async () => {
    const fake = fakeAuth()
    const sessions = createOAuthSessions({ auth: fake.auth }, {
      publicUrl: "https://gw.example.com"
    })
    await sessions.start({
      integration: "google",
      connection: "default",
      authMethod: oauthMethod
    })

    const done = await sessions.completeByState("provider-state-1", { code: "abc" })
    expect(done?.state.status).toBe("connected")
    expect(fake.record.completedState).toBe("provider-state-1")
    expect(fake.record.completedCode).toBe("abc")

    // A replayed callback is consumed, not a second connection.
    expect(await sessions.completeByState("provider-state-1", { code: "abc" })).toBeUndefined()
    expect(await sessions.completeByState("never-seen", { code: "abc" })).toBeUndefined()
  })

  test("records the failure on the session when the exchange is refused", async () => {
    const fake = fakeAuth({ completeFails: true })
    const sessions = createOAuthSessions({ auth: fake.auth }, {
      publicUrl: "https://gw.example.com"
    })
    await sessions.start({
      integration: "google",
      connection: "default",
      authMethod: oauthMethod
    })

    const failed = await sessions.completeByState("provider-state-1", { code: "bad" })
    expect(failed?.state.status).toBe("failed")
    if (failed?.state.status !== "failed") return
    expect(failed.state.message).toContain("token exchange rejected")
  })

  test("local mode still owns an ephemeral listener and needs no public URL", async () => {
    const fake = fakeAuth()
    const sessions = createOAuthSessions({ auth: fake.auth })
    const session = await sessions.start({
      integration: "google",
      connection: "default",
      authMethod: oauthMethod
    })
    // The flow was registered against some 127.0.0.1 port this process bound.
    expect(fake.record.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/)
    expect(session.state.status).toBe("pending")
    sessions.stop()
  })
})


const notStubbed = (member: string) => () => {
  throw new Error(`stubExecutor: ${member} is not stubbed for these tests`)
}

/** A throwing stand-in for the whole executor surface. The callback route
 *  never reaches any of these members; a partial fake that returned undefined
 *  would let a handler quietly start depending on one. */
const stubExecutor = (): ExecutorServices => ({
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
    detectIntegration: notStubbed("catalog.detectIntegration"),
    probeMcp: notStubbed("catalog.probeMcp"),
    previewOpenApi: notStubbed("catalog.previewOpenApi"),
    list: notStubbed("catalog.list"),
    find: notStubbed("catalog.find"),
    addMcp: notStubbed("catalog.addMcp"),
    addOpenApi: notStubbed("catalog.addOpenApi")
  },
  auth: {
    probe: notStubbed("auth.probe"),
    registerClient: notStubbed("auth.registerClient"),
    createClient: notStubbed("auth.createClient"),
    start: notStubbed("auth.start"),
    complete: notStubbed("auth.complete")
  },
  discovery: { inspect: notStubbed("discovery.inspect") },
  provisioning: {
    install: notStubbed("provisioning.install"),
    provision: notStubbed("provisioning.provision")
  },
  validateIntegrationNode: notStubbed("validateIntegrationNode"),
  listIntegrationOverviews: async () => []
})

describe("the hosted callback route", () => {

  const setup = async (
    oauthSessions: Parameters<typeof gatewayRoutes>[0]["oauth"]
  ) => {
    const store = await makeStore()
    const handle = createGatewayHandler({
      store,
      routes: gatewayRoutes({
        store,
        executor: stubExecutor(),
        retentionDays: 30,
        oauth: oauthSessions
      })
    })
    return async (pathname: string) => {
      const response = await handle(new Request(`http://gateway.test${pathname}`))
      const text = await response.text()
      return { status: response.status, text }
    }
  }

  test("connects when the state is known and shows the human a page", async () => {
    let completed: { state?: string; code?: string } | undefined
    const call = await setup({
      start: async () => { throw new Error("not used") },
      get: async () => undefined,
      stop: () => undefined,
      completeByState: async (state, input) => {
        completed = { state, code: input.code }
        return {
          id: "s1",
          integration: "google",
          connection: "default",
          state: { status: "connected", connection: connection("default") }
        }
      }
    })

    const response = await call("/v1/oauth/callback?state=provider-state-1&code=abc")
    expect(response.status).toBe(200)
    expect(response.text).toContain("Account connected")
    expect(completed?.code).toBe("abc")
  })

  test("answers an unknown or error callback with a readable page, not JSON", async () => {
    const unknownCall = await setup({
      start: async () => { throw new Error("not used") },
      get: async () => undefined,
      stop: () => undefined,
      completeByState: async () => undefined
    })
    const unknown = await unknownCall("/v1/oauth/callback?state=stale&code=abc")
    expect(unknown.status).toBe(400)
    expect(unknown.text).toContain("Unknown authorization")

    const erroredCall = await setup({
      start: async () => { throw new Error("not used") },
      get: async () => undefined,
      stop: () => undefined,
      completeByState: async () => undefined
    })
    const errored = await erroredCall(
      "/v1/oauth/callback?state=provider-state-1&error=access_denied&error_description=User%20declined"
    )
    expect(errored.status).toBe(400)
    expect(errored.text).toContain("User declined")
  })

  test("reports a flow that failed during completion", async () => {
    const call = await setup({
      start: async () => { throw new Error("not used") },
      get: async () => undefined,
      stop: () => undefined,
      completeByState: async () => ({
        id: "s1",
        integration: "google",
        connection: "default",
        state: { status: "failed", message: "token exchange rejected" }
      })
    })
    const response = await call("/v1/oauth/callback?state=provider-state-1&code=abc")
    expect(response.status).toBe(400)
    expect(response.text).toContain("token exchange rejected")
  })
})
