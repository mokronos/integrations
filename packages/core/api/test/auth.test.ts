import { run, runAll } from "./effect.ts"
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect, Schema } from "effect"
import { whenPresent } from "@mokronos/contracts"
import {
  ConnectionName,
  createGatewayHandler,
  createGatewayStore,
  defaultTenantId,
  generateApiKey,
  IntegrationSlug,
  newClientId,
  newAccessProfileId,
  newApprovalPolicyId,
  TenantId,
  ToolName
} from "./gateway.ts"
import type { ConnectionRef, GatewayStore } from "./gateway.ts"
import { stubIntegrations } from "./stubs.ts"
import type { GoogleIdentityOAuth } from "@mokronos/gateway-core"

const JsonBody = Schema.Record(Schema.String, Schema.Json)

const directories: Array<string> = []
const stores: Array<GatewayStore> = []

afterEach(async () => {
  await runAll(stores.splice(0).map((store) => store.close()))
  await run(Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  ))
})

const connection: ConnectionRef = {
  owner: "org",
  integration: IntegrationSlug.make("gmail"),
  name: ConnectionName.make("work")
}


interface SetupOptions {
  /** Defaults to false: an operator who says nothing gets a closed gateway. */
  readonly signupOpen?: boolean
  readonly signupOpenOf?: () => Promise<boolean>
  readonly secureCookies?: boolean
  readonly google?: GoogleIdentityOAuth
}

const setup = async (options: SetupOptions = {}) => {
  const directory = await run(mkdtemp(path.join(tmpdir(), "wf-gateway-auth-")))
  directories.push(directory)
  const store = await run(createGatewayStore(path.join(directory, "gateway.sqlite")))
  stores.push(store)

  const accessProfile = await run(store.createAccessProfile({
    id: newAccessProfileId(), tenantId: defaultTenantId, name: "local"
  }))
  await run(store.replaceAccessProfileTools(accessProfile.id, [{
    connection,
    tool: ToolName.make("sendEmail")
  }]))
  const approvalPolicy = await run(store.createApprovalPolicy({
    id: newApprovalPolicyId(), tenantId: defaultTenantId, name: "local"
  }))
  await run(store.replaceApprovalPolicyTools(approvalPolicy.id, [{
      connection,
      tool: ToolName.make("sendEmail"),
      decision: "allow"
    }]))
  const client = await run(store.createClient({
    id: newClientId(),
    tenantId: defaultTenantId,
    accessProfileId: accessProfile.id,
    approvalPolicyId: approvalPolicy.id,
    name: "local",
    capabilities: ["provision_connections", "administer_gateway"]
  }))
  const apiKey = generateApiKey()
  await run(store.addApiKey({ id: apiKey.id, clientId: client.id, hash: apiKey.hash }))

  const { handle } = createGatewayHandler({
    store,
    integrations: stubIntegrations(),
    retentionDays: 30,
    oauth: {
      start: () => Effect.die(new Error("not used")),
      get: () => Effect.sync((): undefined => undefined),
      completeByState: () => Effect.sync((): undefined => undefined),
      stop: () => Effect.void
    },
    sessions: {
      signupOpen: options.signupOpenOf === undefined
        ? () => Effect.succeed(options.signupOpen ?? false)
        : () => Effect.promise(() => options.signupOpenOf?.() ?? Promise.resolve(false)),
      secureCookies: options.secureCookies ?? false,
      ...whenPresent("google", options.google)
    }
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
    const response = await run(handle(new Request(`http://gateway.test${pathname}`, init.body === undefined
      ? { method, headers }
      : { method, headers, body: JSON.stringify(init.body) })))
    return {
      status: response.status,
      body: Schema.decodeUnknownSync(JsonBody)(await run(response.json())),
      setCookie: response.headers.get("set-cookie")
    }
  }

  const cookieValue = (setCookie: string | null): string => {
    const match = /^wf_session=([^;]+)/.exec(setCookie ?? "")
    if (match?.[1] === undefined) throw new Error(`no session cookie in ${String(setCookie)}`)
    return match[1]
  }

  return { store, client, apiKey, call, cookieValue, handle }
}

/** A signed-up human with their cookie, ready to act as the dashboard does. */
const signupHuman = async (
  setup_: Awaited<ReturnType<typeof setup>>,
  email = "sebastian@example.com",
  password = "correct horse battery"
) => {
  const response = await run(setup_.call("POST", "/v1/auth/signup", {
    body: { email, password },
    headers: { origin: "http://gateway.test", "sec-fetch-site": "same-origin" }
  }))
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

const googleIdentity = (): GoogleIdentityOAuth => ({
  clientId: "google-client",
  clientSecret: "google-secret",
  publicUrlOf: () => "http://gateway.test",
  fetch: Object.assign(
    async (input: Parameters<typeof globalThis.fetch>[0]): Promise<Response> => {
      const url = String(input)
      if (url === "https://oauth2.googleapis.com/token") {
        return Response.json({ access_token: "google-access-token" })
      }
      if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
        return Response.json({
          sub: "google-subject-1",
          email: "google@example.com",
          email_verified: true
        })
      }
      throw new Error(`Unexpected Google request: ${url}`)
    },
    { preconnect: globalThis.fetch.preconnect }
  )
})

const oauthStateFrom = (response: Response): string => {
  const location = response.headers.get("location")
  if (location === null) throw new Error("Google redirect did not contain a location")
  const state = new URL(location).searchParams.get("state")
  if (state === null) throw new Error("Google redirect did not contain state")
  return state
}

describe("signup", () => {
  test("the first human claims a fresh tenant and a live session", async () => {
    const setup_ = await run(setup({ signupOpen: true }))
    const human = await run(signupHuman(setup_))

    const logins = await run(setup_.store.countLogins())
    expect(logins).toBe(1)
    // The tenant id came off the wire as a plain string; findTenantById both
    // re-validates it and proves the partition exists with its subject.
    const tenant = await run(setup_.store.findTenantById(TenantId.make(human.tenantId)))
    expect(tenant).toBeDefined()
    const subjects = await run(setup_.store.listSubjects(TenantId.make(human.tenantId)))
    expect(subjects).toHaveLength(1)
    expect(human.cookie).toStartWith("wfs_")

    const me = await run(setup_.call("GET", "/v1/auth/me", { cookie: human.cookie }))
    expect(me.body["authenticated"]).toBe(true)
    expect(me.body["kind"]).toBe("session")
    expect(me.body["email"]).toBe(human.email)
    expect(me.body["tenantId"]).toBe(human.tenantId)
    expect(me.body["subjectId"]).toBe(subjects[0]?.id)
  })

  test("rechecks whether signup is open for every account creation", async () => {
    let open = true
    const setup_ = await run(setup({ signupOpenOf: async () => open }))
    await run(signupHuman(setup_))
    open = false

    const response = await run(setup_.call("POST", "/v1/auth/signup", {
      body: { email: "second@example.com", password: "correct horse battery" },
      headers: { origin: "http://gateway.test", "sec-fetch-site": "same-origin" }
    }))

    expect(response.status).toBe(403)
    expect(response.body["code"]).toBe("signup-closed")
    const providers = await run(setup_.call("GET", "/v1/auth/providers"))
    expect(providers.body["signupOpen"]).toBe(false)
  })

  test("is closed unless asked otherwise", async () => {
    const setup_ = await run(setup({ signupOpen: false }))
    const response = await run(setup_.call("POST", "/v1/auth/signup", {
      body: { email: "sebastian@example.com", password: "correct horse battery" }
    }))
    expect(response.status).toBe(403)
    expect(response.body["code"]).toBe("signup-closed")
  })

  test("rejects a short password and a malformed email at the boundary", async () => {
    const setup_ = await run(setup({ signupOpen: true }))
    const short = await run(setup_.call("POST", "/v1/auth/signup", {
      body: { email: "a@example.com", password: "short" }
    }))
    expect(short.status).toBe(400)
    const malformed = await run(setup_.call("POST", "/v1/auth/signup", {
      body: { email: "not-an-email", password: "correct horse battery" }
    }))
    expect(malformed.status).toBe(400)
  })

  test("does not mint a second account for a taken email", async () => {
    const setup_ = await run(setup({ signupOpen: true }))
    const first = await run(signupHuman(setup_))
    const second = await run(setup_.call("POST", "/v1/auth/signup", {
      body: { email: first.email, password: "another passphrase here" }
    }))
    expect(second.status).toBe(400)
    expect(String(second.body["error"])).toContain("already exists")
  })
})

describe("login", () => {
  test("accepts the credentials it issued", async () => {
    const setup_ = await run(setup({ signupOpen: true }))
    const human = await run(signupHuman(setup_))

    const login = await run(setup_.call("POST", "/v1/auth/login", {
      body: { email: human.email, password: human.password }
    }))

    expect(login.status).toBe(200)
    expect(login.setCookie).toContain("wf_session=wfs_")
  })

  test("answers the same for unknown email and wrong password", async () => {
    const setup_ = await run(setup({ signupOpen: true }))
    const human = await run(signupHuman(setup_))

    const wrongPassword = await run(setup_.call("POST", "/v1/auth/login", {
      body: { email: human.email, password: "not the passphrase" }
    }))
    const unknownEmail = await run(setup_.call("POST", "/v1/auth/login", {
      body: { email: "nobody@example.com", password: "whatever goes here" }
    }))

    // Telling them apart lets a harvester confirm which emails have accounts.
    expect(wrongPassword.status).toBe(401)
    expect(unknownEmail.status).toBe(401)
    expect(wrongPassword.body["error"]).toBe(unknownEmail.body["error"])
    expect(wrongPassword.body["code"]).toBe("invalid-credentials")
  })
})

describe("Google identity and CLI handoff", () => {
  test("signs ii in through a one-time browser handoff", async () => {
    const setup_ = await run(setup({ signupOpen: true, google: googleIdentity() }))
    const providers = await run(setup_.call("GET", "/v1/auth/providers"))
    expect(providers.body["google"]).toEqual({
      enabled: true,
      startUrl: "/v1/auth/google/start",
      callbackUrl: "http://gateway.test/v1/auth/google/callback"
    })
    expect(providers.body["signupOpen"]).toBe(true)

    const handoff = await run(setup_.call("POST", "/v1/auth/cli/start"))
    expect(handoff.status).toBe(201)
    const requestId = String(handoff.body["requestId"])
    expect(requestId).toStartWith("wfl_")

    const start = await run(setup_.handle(new Request(String(handoff.body["authorizationUrl"]))))
    expect(start.status).toBe(302)
    const callback = await run(setup_.handle(new Request(
      `http://gateway.test/v1/auth/google/callback?state=${encodeURIComponent(oauthStateFrom(start))}&code=code-1`
    )))
    expect(callback.status).toBe(200)
    expect(await run(callback.text())).toContain("The terminal is authenticated")

    const collected = await run(setup_.call("GET", `/v1/auth/cli/${encodeURIComponent(requestId)}`))
    expect(collected.body["status"]).toBe("authenticated")
    expect(collected.body["email"]).toBe("google@example.com")
    const token = String(collected.body["token"])
    expect(token).toStartWith("wfs_")
    const replay = await run(setup_.call("GET", `/v1/auth/cli/${encodeURIComponent(requestId)}`))
    expect(replay.status).toBe(410)

    const me = await run(setup_.call("GET", "/v1/auth/me", { cookie: token }))
    expect(me.body["hasPassword"]).toBe(false)
    expect(me.body["identityProviders"]).toEqual(["google"])
    const passwordLogin = await run(setup_.call("POST", "/v1/auth/login", {
      body: { email: "google@example.com", password: "not configured" }
    }))
    expect(passwordLogin.status).toBe(401)

    const added = await run(setup_.call("POST", "/v1/auth/password", {
      body: { newPassword: "new correct horse battery" },
      cookie: token,
      headers: { origin: "http://gateway.test", "sec-fetch-site": "same-origin" }
    }))
    expect(added.status).toBe(200)
    const after = await run(setup_.call("POST", "/v1/auth/login", {
      body: { email: "google@example.com", password: "new correct horse battery" }
    }))
    expect(after.status).toBe(200)
  })

  test("returns a dashboard sign-in to a safe local path", async () => {
    const setup_ = await run(setup({ signupOpen: true, google: googleIdentity() }))
    const start = await run(setup_.handle(new Request(
      "http://gateway.test/v1/auth/google/start?returnTo=%2Fapprovals%3Fapproval%3Dap_1"
    )))
    const callback = await run(setup_.handle(new Request(
      `http://gateway.test/v1/auth/google/callback?state=${encodeURIComponent(oauthStateFrom(start))}&code=code-2`
    )))
    expect(callback.status).toBe(302)
    expect(callback.headers.get("location")).toBe("/approvals?approval=ap_1")
    expect(callback.headers.get("set-cookie")).toContain("wf_session=wfs_")

    const unsafeStart = await run(setup_.handle(new Request(
      "http://gateway.test/v1/auth/google/start?returnTo=%2F%2Fevil.example"
    )))
    const unsafeCallback = await run(setup_.handle(new Request(
      `http://gateway.test/v1/auth/google/callback?state=${encodeURIComponent(oauthStateFrom(unsafeStart))}&code=code-3`
    )))
    expect(unsafeCallback.headers.get("location")).toBe("/")
  })
})

describe("what a session may do", () => {
  test("reads administrative surfaces without holding any API key", async () => {
    const setup_ = await run(setup({ signupOpen: true }))
    const human = await run(signupHuman(setup_))

    const clients = await run(setup_.call("GET", "/v1/clients", { cookie: human.cookie }))
    expect(clients.status).toBe(200)

    const audit = await run(setup_.call("GET", "/v1/audit", { cookie: human.cookie }))
    expect(audit.status).toBe(200)
    expect(audit.body["total"]).toBe(0)
  })

  test("never reaches the delegated surface — delegation needs a key", async () => {
    const setup_ = await run(setup({ signupOpen: true }))
    const human = await run(signupHuman(setup_))

    const tools = await run(setup_.call("GET", "/v1/tools", { cookie: human.cookie }))
    expect(tools.status).toBe(403)
    expect(tools.body["code"]).toBe("not-permitted")

    const execute = await run(setup_.call("POST", "/v1/execute", {
      body: { alias: "gmail-work", tool: "sendEmail" },
      cookie: human.cookie,
      headers: { origin: "http://gateway.test", "sec-fetch-site": "same-origin" }
    }))
    expect(execute.status).toBe(403)
  })

  test("is scoped to its own tenant", async () => {
    const setup_ = await run(setup({ signupOpen: true }))
    const human = await run(signupHuman(setup_))
    expect(String((human.tenantId))).not.toBe(defaultTenantId)

    // The local client belongs to the default tenant; a human in another
    // partition must not see it listed.
    const clients = Schema.decodeUnknownSync(
      Schema.Array(Schema.Record(Schema.String, Schema.Json))
    )(
      (await run(setup_.call("GET", "/v1/clients", { cookie: human.cookie }))).body["clients"]
    )
    expect(clients).toHaveLength(0)
  })
})

describe("cross-site protection for cookie-carried authority", () => {
  test("blocks a write with neither Origin nor Sec-Fetch-Site", async () => {
    const setup_ = await run(setup({ signupOpen: true }))
    const human = await run(signupHuman(setup_))

    const response = await run(setup_.call("POST", "/v1/clients", {
      body: { name: "from-another-site" },
      cookie: human.cookie
    }))
    expect(response.status).toBe(403)
    expect(response.body["code"]).toBe("cross-site")
  })

  test("blocks a write whose Origin names another site", async () => {
    const setup_ = await run(setup({ signupOpen: true }))
    const human = await run(signupHuman(setup_))

    const response = await run(setup_.call("POST", "/v1/clients", {
      body: { name: "from-another-site" },
      cookie: human.cookie,
      headers: { origin: "https://evil.example" }
    }))
    expect(response.status).toBe(403)
    expect(response.body["code"]).toBe("cross-site")
  })

  test("allows a same-origin attested write and exempts reads entirely", async () => {
    const setup_ = await run(setup({ signupOpen: true }))
    const human = await run(signupHuman(setup_))

    const write = await run(setup_.call("POST", "/v1/clients", {
      body: { name: "sandbox" },
      cookie: human.cookie,
      headers: { origin: "http://gateway.test", "sec-fetch-site": "same-origin" }
    }))
    expect(write.status).toBe(201)

    // A browser navigation sends no Sec-Fetch-Site on some paths; reads never
    // needed the guard because they change nothing.
    const read = await run(setup_.call("GET", "/v1/clients", { cookie: human.cookie }))
    expect(read.status).toBe(200)
  })
})

describe("logout", () => {
  test("revokes the session server-side, not just the cookie", async () => {
    const setup_ = await run(setup({ signupOpen: true }))
    const human = await run(signupHuman(setup_))

    const logout = await run(setup_.call("POST", "/v1/auth/logout", {
      cookie: human.cookie,
      headers: { origin: "http://gateway.test", "sec-fetch-site": "same-origin" }
    }))
    expect(logout.status).toBe(200)

    // A stolen cookie copied before logout stays dead too: the row is gone.
    const replayed = await run(setup_.call("GET", "/v1/auth/me", { cookie: human.cookie }))
    expect(replayed.body).toEqual({ authenticated: false })
    const surface = await run(setup_.call("GET", "/v1/clients", { cookie: human.cookie }))
    expect(surface.status).toBe(401)
  })

  test("is harmless without a session at all", async () => {
    const setup_ = await run(setup({ signupOpen: true }))
    const response = await run(setup_.call("POST", "/v1/auth/logout"))
    expect(response.status).toBe(200)
  })
})

describe("credential precedence", () => {
  test("an explicit key wins over a valid cookie", async () => {
    const setup_ = await run(setup({ signupOpen: true }))
    const human = await run(signupHuman(setup_))
    void human

    const me = await run(setup_.call("GET", "/v1/auth/me", {
      cookie: (await run(signupHuman(setup_, "second@example.com"))).cookie,
      headers: { authorization: `Bearer ${setup_.apiKey.secret}` }
    }))
    expect(me.body["kind"]).toBe("client")
    expect(me.body["clientId"]).toBe(setup_.client.id)
  })

  test("a refused key is reported even when a valid cookie sits next to it", async () => {
    const setup_ = await run(setup({ signupOpen: true }))
    const human = await run(signupHuman(setup_))

    // Precedence means the bad key speaks: the caller asked to be someone
    // specific and was refused, so answering as the cookie would hide that.
    const response = await run(setup_.call("GET", "/v1/clients", {
      cookie: human.cookie,
      headers: { authorization: "Bearer wfi_not-a-real-key" }
    }))
    expect(response.status).toBe(401)
    expect(response.body["code"]).toBe("unknown-key")
  })
})

describe("attribution", () => {
  test("an approval decided by a session records the human's email", async () => {
    const setup_ = await run(setup({ signupOpen: true }))
    const human = await run(signupHuman(setup_))

    // A frozen call inside the human's own partition, so the session is the
    // authority that settles it.
    const accessProfile = await run(setup_.store.createAccessProfile({
      id: newAccessProfileId(), tenantId: human.tenantId, name: "support-agent"
    }))
    await run(setup_.store.replaceAccessProfileTools(accessProfile.id, [{
      connection,
      tool: ToolName.make("sendEmail")
    }]))
    const approvalPolicy = await run(setup_.store.createApprovalPolicy({
      id: newApprovalPolicyId(), tenantId: human.tenantId, name: "support-agent"
    }))
    await run(setup_.store.replaceApprovalPolicyTools(approvalPolicy.id, [{
        connection,
        tool: ToolName.make("sendEmail"),
        decision: "require_approval"
      }]))
    const client = await run(setup_.store.createClient({
      id: newClientId(),
      tenantId: human.tenantId,
      accessProfileId: accessProfile.id,
      approvalPolicyId: approvalPolicy.id,
      name: "support-agent",
      capabilities: ["provision_connections"]
    }))
    const key = generateApiKey()
    await run(setup_.store.addApiKey({ id: key.id, clientId: client.id, hash: key.hash }))

    const frozen = await run(setup_.call("POST", "/v1/execute", {
      body: { alias: "gmail-work", tool: "sendEmail", arguments: {} },
      headers: { authorization: `Bearer ${key.secret}` }
    }))
    expect(frozen.body["status"]).toBe("pending")
    const approvalId = String(frozen.body["approvalId"])

    // ...and deny it from the dashboard, where the human is known.
    const denied = await run(setup_.call("POST", `/v1/approvals/${approvalId}/deny`, {
      body: { decidedBy: "spoofed@example.com" },
      cookie: human.cookie,
      headers: { origin: "http://gateway.test", "sec-fetch-site": "same-origin" }
    }))
    expect(denied.status).toBe(200)
    const approval = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(
      denied.body["approval"]
    )
    expect(approval["decidedBy"]).toBe(human.email)
  })
})

describe("cookie hardening", () => {
  test("issued cookies are HttpOnly and SameSite=Lax", async () => {
    const setup_ = await run(setup({ signupOpen: true }))
    const response = await run(setup_.call("POST", "/v1/auth/signup", {
      body: { email: "hardened@example.com", password: "correct horse battery" },
      headers: { origin: "http://gateway.test", "sec-fetch-site": "same-origin" }
    }))
    expect(response.setCookie ?? "").toContain("HttpOnly")
    expect(response.setCookie ?? "").toContain("SameSite=Lax")
    expect((response.setCookie ?? "").includes("; Secure")).toBe(false)
  })

  test("a deployment behind TLS marks its cookies Secure", async () => {
    const setup_ = await run(setup({ signupOpen: true, secureCookies: true }))
    const response = await run(setup_.call("POST", "/v1/auth/signup", {
      body: { email: "tls@example.com", password: "correct horse battery" },
      headers: { origin: "https://gateway.test", "sec-fetch-site": "same-origin" }
    }))
    expect(response.setCookie ?? "").toContain("; Secure")
  })
})
