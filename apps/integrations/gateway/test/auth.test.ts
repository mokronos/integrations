import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Schema } from "effect"
import { whenPresent } from "@mokronos/wfkit"
import type { ExecutorServices } from "@mokronos/wfkit-executor"
import {
  Alias,
  ConnectionName,
  createGatewayHandler,
  createGatewayStore,
  defaultTenantId,
  generateApiKey,
  IntegrationSlug,
  gatewayRoutes,
  newClientId,
  newGrantId,
  TenantId,
  ToolName
} from "../src/index.ts"
import type { ConnectionRef, GatewayStore } from "../src/index.ts"

const JsonBody = Schema.Record(Schema.String, Schema.Json)

const directories: Array<string> = []
const stores: Array<GatewayStore> = []

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()))
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

const connection: ConnectionRef = {
  owner: "org",
  integration: IntegrationSlug.make("gmail"),
  name: ConnectionName.make("work")
}

const notStubbed = (member: string) => () => {
  throw new Error(`stubExecutor: ${member} is not stubbed for these tests`)
}

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

interface SetupOptions {
  /** Defaults to false: an operator who says nothing gets a closed gateway. */
  readonly signupOpen?: boolean
  readonly secureCookies?: boolean
}

const setup = async (options: SetupOptions = {}) => {
  const directory = await mkdtemp(path.join(tmpdir(), "wf-gateway-auth-"))
  directories.push(directory)
  const store = await createGatewayStore(path.join(directory, "gateway.sqlite"))
  stores.push(store)

  // A standing client with a grant, so delegation boundaries are testable
  // against a real privileged surface.
  const client = await store.createClient({
    id: newClientId(),
    tenantId: defaultTenantId,
    name: "local",
    mayMutate: true
  })
  const apiKey = generateApiKey()
  await store.addApiKey({ id: apiKey.id, clientId: client.id, hash: apiKey.hash })
  await store.createGrant({
    id: newGrantId(),
    tenantId: defaultTenantId,
    clientId: client.id,
    alias: Alias.make("gmail-work"),
    tool: ToolName.make("sendEmail"),
    connection,
    decision: "allow"
  })

  const handle = createGatewayHandler({
    store,
    routes: gatewayRoutes({
      store,
      executor: stubExecutor(),
      retentionDays: 30,
      oauth: {
        start: async () => { throw new Error("not used") },
        get: async () => undefined,
        completeByState: async () => undefined,
        stop: () => undefined
      },
      sessions: {
        signupOpen: options.signupOpen ?? false,
        secureCookies: options.secureCookies ?? false
      }
    })
  })

  interface CallInit {
    readonly body?: unknown
    readonly headers?: Record<string, string>
    /** Sent raw; a cookie value captured from a previous Set-Cookie. */
    readonly cookie?: string
  }

  const call = async (method: string, pathname: string, init: CallInit = {}) => {
    const headers = {
      "content-type": "application/json",
      ...whenPresent("cookie", init.cookie === undefined ? undefined : `wf_session=${init.cookie}`),
      ...init.headers
    }
    const response = await handle(new Request(`http://gateway.test${pathname}`, init.body === undefined
      ? { method, headers }
      : { method, headers, body: JSON.stringify(init.body) }))
    return {
      status: response.status,
      body: Schema.decodeUnknownSync(JsonBody)(await response.json()),
      setCookie: response.headers.get("set-cookie")
    }
  }

  const cookieValue = (setCookie: string | null): string => {
    const match = /^wf_session=([^;]+)/.exec(setCookie ?? "")
    if (match?.[1] === undefined) throw new Error(`no session cookie in ${String(setCookie)}`)
    return match[1]
  }

  return { store, client, apiKey, call, cookieValue }
}

/** A signed-up human with their cookie, ready to act as the dashboard does. */
const signupHuman = async (
  setup_: Awaited<ReturnType<typeof setup>>,
  email = "sebastian@example.com",
  password = "correct horse battery"
) => {
  const response = await setup_.call("POST", "/v1/auth/signup", {
    body: { email, password },
    headers: { origin: "http://gateway.test", "sec-fetch-site": "same-origin" }
  })
  expect(response.status).toBe(201)
  return {
    email,
    password,
    tenantId: TenantId.make(
      String((Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(response.body["tenant"]))["id"])
    ),
    cookie: setup_.cookieValue(response.setCookie)
  }
}

describe("signup", () => {
  test("the first human claims a fresh tenant and a live session", async () => {
    const setup_ = await setup({ signupOpen: true })
    const human = await signupHuman(setup_)

    const logins = await setup_.store.countLogins()
    expect(logins).toBe(1)
    // The tenant id came off the wire as a plain string; findTenantById both
    // re-validates it and proves the partition exists with its subject.
    const tenant = await setup_.store.findTenantById(TenantId.make(human.tenantId))
    expect(tenant).toBeDefined()
    const subjects = await setup_.store.listSubjects(TenantId.make(human.tenantId))
    expect(subjects).toHaveLength(1)
    expect(human.cookie).toStartWith("wfs_")

    const me = await setup_.call("GET", "/v1/auth/me", { cookie: human.cookie })
    expect(me.body["authenticated"]).toBe(true)
    expect(me.body["kind"]).toBe("session")
    expect(me.body["email"]).toBe(human.email)
    expect(me.body["tenantId"]).toBe(human.tenantId)
    expect(me.body["subjectId"]).toBe(subjects[0]?.id)
  })

  test("is closed unless asked otherwise", async () => {
    const setup_ = await setup({ signupOpen: false })
    const response = await setup_.call("POST", "/v1/auth/signup", {
      body: { email: "sebastian@example.com", password: "correct horse battery" }
    })
    expect(response.status).toBe(403)
    expect(response.body["code"]).toBe("signup-closed")
  })

  test("rejects a short password and a malformed email at the boundary", async () => {
    const setup_ = await setup({ signupOpen: true })
    const short = await setup_.call("POST", "/v1/auth/signup", {
      body: { email: "a@example.com", password: "short" }
    })
    expect(short.status).toBe(400)
    const malformed = await setup_.call("POST", "/v1/auth/signup", {
      body: { email: "not-an-email", password: "correct horse battery" }
    })
    expect(malformed.status).toBe(400)
  })

  test("does not mint a second account for a taken email", async () => {
    const setup_ = await setup({ signupOpen: true })
    const first = await signupHuman(setup_)
    const second = await setup_.call("POST", "/v1/auth/signup", {
      body: { email: first.email, password: "another passphrase here" }
    })
    expect(second.status).toBe(400)
    expect(String(second.body["error"])).toContain("already exists")
  })
})

describe("login", () => {
  test("accepts the credentials it issued", async () => {
    const setup_ = await setup({ signupOpen: true })
    const human = await signupHuman(setup_)

    const login = await setup_.call("POST", "/v1/auth/login", {
      body: { email: human.email, password: human.password }
    })

    expect(login.status).toBe(200)
    expect(login.setCookie).toContain("wf_session=wfs_")
  })

  test("answers the same for unknown email and wrong password", async () => {
    const setup_ = await setup({ signupOpen: true })
    const human = await signupHuman(setup_)

    const wrongPassword = await setup_.call("POST", "/v1/auth/login", {
      body: { email: human.email, password: "not the passphrase" }
    })
    const unknownEmail = await setup_.call("POST", "/v1/auth/login", {
      body: { email: "nobody@example.com", password: "whatever goes here" }
    })

    // Telling them apart lets a harvester confirm which emails have accounts.
    expect(wrongPassword.status).toBe(401)
    expect(unknownEmail.status).toBe(401)
    expect(wrongPassword.body["error"]).toBe(unknownEmail.body["error"])
    expect(wrongPassword.body["code"]).toBe("invalid-credentials")
  })
})

describe("what a session may do", () => {
  test("reads privileged surfaces without holding any API key", async () => {
    const setup_ = await setup({ signupOpen: true })
    const human = await signupHuman(setup_)

    const clients = await setup_.call("GET", "/v1/clients", { cookie: human.cookie })
    expect(clients.status).toBe(200)

    const audit = await setup_.call("GET", "/v1/audit", { cookie: human.cookie })
    expect(audit.status).toBe(200)
    expect(audit.body["total"]).toBe(0)
  })

  test("never reaches the delegated surface — delegation needs a key", async () => {
    const setup_ = await setup({ signupOpen: true })
    const human = await signupHuman(setup_)

    const tools = await setup_.call("GET", "/v1/tools", { cookie: human.cookie })
    expect(tools.status).toBe(403)
    expect(tools.body["code"]).toBe("not-permitted")

    const execute = await setup_.call("POST", "/v1/execute", {
      body: { alias: "gmail-work", tool: "sendEmail" },
      cookie: human.cookie,
      headers: { origin: "http://gateway.test", "sec-fetch-site": "same-origin" }
    })
    expect(execute.status).toBe(403)
  })

  test("is scoped to its own tenant", async () => {
    const setup_ = await setup({ signupOpen: true })
    const human = await signupHuman(setup_)
    expect(String((human.tenantId))).not.toBe(defaultTenantId)

    // The local client belongs to the default tenant; a human in another
    // partition must not see it listed.
    const clients = Schema.decodeUnknownSync(
      Schema.Array(Schema.Record(Schema.String, Schema.Json))
    )(
      (await setup_.call("GET", "/v1/clients", { cookie: human.cookie })).body["clients"]
    )
    expect(clients).toHaveLength(0)
  })
})

describe("cross-site protection for cookie-carried authority", () => {
  test("blocks a write with neither Origin nor Sec-Fetch-Site", async () => {
    const setup_ = await setup({ signupOpen: true })
    const human = await signupHuman(setup_)

    const response = await setup_.call("POST", "/v1/clients", {
      body: { name: "from-another-site" },
      cookie: human.cookie
    })
    expect(response.status).toBe(403)
    expect(response.body["code"]).toBe("cross-site")
  })

  test("blocks a write whose Origin names another site", async () => {
    const setup_ = await setup({ signupOpen: true })
    const human = await signupHuman(setup_)

    const response = await setup_.call("POST", "/v1/clients", {
      body: { name: "from-another-site" },
      cookie: human.cookie,
      headers: { origin: "https://evil.example" }
    })
    expect(response.status).toBe(403)
    expect(response.body["code"]).toBe("cross-site")
  })

  test("allows a same-origin attested write and exempts reads entirely", async () => {
    const setup_ = await setup({ signupOpen: true })
    const human = await signupHuman(setup_)

    const write = await setup_.call("POST", "/v1/clients", {
      body: { name: "sandbox" },
      cookie: human.cookie,
      headers: { origin: "http://gateway.test", "sec-fetch-site": "same-origin" }
    })
    expect(write.status).toBe(201)

    // A browser navigation sends no Sec-Fetch-Site on some paths; reads never
    // needed the guard because they change nothing.
    const read = await setup_.call("GET", "/v1/clients", { cookie: human.cookie })
    expect(read.status).toBe(200)
  })
})

describe("logout", () => {
  test("revokes the session server-side, not just the cookie", async () => {
    const setup_ = await setup({ signupOpen: true })
    const human = await signupHuman(setup_)

    const logout = await setup_.call("POST", "/v1/auth/logout", {
      cookie: human.cookie,
      headers: { origin: "http://gateway.test", "sec-fetch-site": "same-origin" }
    })
    expect(logout.status).toBe(200)

    // A stolen cookie copied before logout stays dead too: the row is gone.
    const replayed = await setup_.call("GET", "/v1/auth/me", { cookie: human.cookie })
    expect(replayed.body).toEqual({ authenticated: false })
    const surface = await setup_.call("GET", "/v1/clients", { cookie: human.cookie })
    expect(surface.status).toBe(401)
  })

  test("is harmless without a session at all", async () => {
    const setup_ = await setup({ signupOpen: true })
    const response = await setup_.call("POST", "/v1/auth/logout")
    expect(response.status).toBe(200)
  })
})

describe("credential precedence", () => {
  test("an explicit key wins over a valid cookie", async () => {
    const setup_ = await setup({ signupOpen: true })
    const human = await signupHuman(setup_)
    void human

    const me = await setup_.call("GET", "/v1/auth/me", {
      cookie: (await signupHuman(setup_, "second@example.com")).cookie,
      headers: { authorization: `Bearer ${setup_.apiKey.secret}` }
    })
    expect(me.body["kind"]).toBe("client")
    expect(me.body["clientId"]).toBe(setup_.client.id)
  })

  test("a refused key is reported even when a valid cookie sits next to it", async () => {
    const setup_ = await setup({ signupOpen: true })
    const human = await signupHuman(setup_)

    // Precedence means the bad key speaks: the caller asked to be someone
    // specific and was refused, so answering as the cookie would hide that.
    const response = await setup_.call("GET", "/v1/clients", {
      cookie: human.cookie,
      headers: { authorization: "Bearer wfi_not-a-real-key" }
    })
    expect(response.status).toBe(401)
    expect(response.body["code"]).toBe("unknown-key")
  })
})

describe("attribution", () => {
  test("an approval decided by a session records the human's email", async () => {
    const setup_ = await setup({ signupOpen: true })
    const human = await signupHuman(setup_)

    // A frozen call inside the human's own partition, so the session is the
    // authority that settles it.
    const client = await setup_.store.createClient({
      id: newClientId(),
      tenantId: human.tenantId,
      name: "support-agent",
      mayMutate: false
    })
    const key = generateApiKey()
    await setup_.store.addApiKey({ id: key.id, clientId: client.id, hash: key.hash })
    await setup_.store.createGrant({
      id: newGrantId(),
      tenantId: human.tenantId,
      clientId: client.id,
      alias: Alias.make("gmail-work"),
      tool: ToolName.make("sendEmail"),
      connection,
      decision: "require_approval"
    })

    const frozen = await setup_.call("POST", "/v1/execute", {
      body: { alias: "gmail-work", tool: "sendEmail", arguments: {} },
      headers: { authorization: `Bearer ${key.secret}` }
    })
    expect(frozen.body["status"]).toBe("pending")
    const approvalId = String(frozen.body["approvalId"])

    // ...and deny it from the dashboard, where the human is known.
    const denied = await setup_.call("POST", `/v1/approvals/${approvalId}/deny`, {
      body: {},
      cookie: human.cookie,
      headers: { origin: "http://gateway.test", "sec-fetch-site": "same-origin" }
    })
    expect(denied.status).toBe(200)
    const approval = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(
      denied.body["approval"]
    )
    expect(approval["decidedBy"]).toBe(human.email)
  })
})

describe("cookie hardening", () => {
  test("issued cookies are HttpOnly and SameSite=Lax", async () => {
    const setup_ = await setup({ signupOpen: true })
    const response = await setup_.call("POST", "/v1/auth/signup", {
      body: { email: "hardened@example.com", password: "correct horse battery" },
      headers: { origin: "http://gateway.test", "sec-fetch-site": "same-origin" }
    })
    expect(response.setCookie ?? "").toContain("HttpOnly")
    expect(response.setCookie ?? "").toContain("SameSite=Lax")
    expect((response.setCookie ?? "").includes("; Secure")).toBe(false)
  })

  test("a deployment behind TLS marks its cookies Secure", async () => {
    const setup_ = await setup({ signupOpen: true, secureCookies: true })
    const response = await setup_.call("POST", "/v1/auth/signup", {
      body: { email: "tls@example.com", password: "correct horse battery" },
      headers: { origin: "https://gateway.test", "sec-fetch-site": "same-origin" }
    })
    expect(response.setCookie ?? "").toContain("; Secure")
  })
})
