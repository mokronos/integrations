import { describe, expect, it } from "@effect/vitest"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { whenPresent } from "@integrations/contracts"
import {
  ConnectionName,
  createGatewayHandler,
  defaultTenantId,
  generateApiKey,
  IntegrationSlug,
  newClientId,
  newAccessProfileId,
  newApprovalPolicyId,
  TenantId,
  ToolName
} from "./gateway.ts"
import type { ConnectionRef } from "./gateway.ts"
import { stubIntegrationsContext } from "./stubs.ts"
import { gatewayStore, testServices } from "./fixtures.ts"
import type { IntegrationServices } from "@integrations/integrations"
import type { GoogleIdentityOAuth } from "@integrations/gateway-core"

const JsonBody = Schema.Record(Schema.String, Schema.Json)

interface CallInit {
  readonly body?: typeof Schema.Json.Type
  readonly headers?: Record<string, string>
  readonly cookie?: string
}

interface CallResult {
  readonly status: number
  readonly body: typeof JsonBody.Type
  readonly setCookie: string | null
}

const connection: ConnectionRef = {
  owner: "org",
  integration: IntegrationSlug.make("gmail"),
  name: ConnectionName.make("work")
}


interface SetupOptions {
  readonly signupOpen?: boolean
  readonly signupOpenOf?: () => Promise<boolean>
  readonly secureCookies?: boolean
  readonly google?: GoogleIdentityOAuth
  readonly integrationServices?: Context.Context<IntegrationServices>
}

const setup = Effect.fnUntraced(function*(options: SetupOptions = {}) {
  const store = yield* gatewayStore("gateway-auth-")

  const accessProfile = yield* store.createAccessProfile({
    id: (yield* newAccessProfileId), tenantId: defaultTenantId, name: "local"
  })
  yield* store.replaceAccessProfileTools(accessProfile.id, [{
    connection,
    tool: ToolName.make("sendEmail")
  }])
  const approvalPolicy = yield* store.createApprovalPolicy({
    id: (yield* newApprovalPolicyId), tenantId: defaultTenantId, name: "local"
  })
  yield* store.replaceApprovalPolicyTools(approvalPolicy.id, [{
      connection,
      tool: ToolName.make("sendEmail"),
      decision: "allow"
    }])
  const client = yield* store.createClient({
    id: (yield* newClientId),
    tenantId: defaultTenantId,
    accessProfileId: accessProfile.id,
    approvalPolicyId: approvalPolicy.id,
    name: "local",
    capabilities: ["provision_connections", "administer_gateway"]
  })
  const apiKey = (yield* generateApiKey)
  yield* store.addApiKey({ id: apiKey.id, clientId: client.id, hash: apiKey.hash })

  const { handle } = createGatewayHandler({
    httpClient: options.google === undefined ? FetchHttpClient.layer : googleHttpClient,
    integrationServices: options.integrationServices ?? stubIntegrationsContext(),
    store,
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

  const call = Effect.fnUntraced(function*(method: string, pathname: string, init: CallInit = {}) {
    const headers = {
      "content-type": "application/json",
      ...whenPresent("cookie", init.cookie === undefined ? undefined : `wf_session=${init.cookie}`),
      ...init.headers
    }
    const response = yield* Effect.promise(() =>
      handle(new Request(`http://gateway.test${pathname}`, init.body === undefined
        ? { method, headers }
        : { method, headers, body: JSON.stringify(init.body) })))
    return {
      status: response.status,
      body: Schema.decodeUnknownSync(JsonBody)(yield* Effect.promise(() => response.json())),
      setCookie: response.headers.get("set-cookie")
    }
  })

  const cookieValue = (setCookie: string | null): string => {
    const match = /^wf_session=([^;]+)/.exec(setCookie ?? "")
    if (match?.[1] === undefined) throw new Error(`no session cookie in ${String(setCookie)}`)
    return match[1]
  }

  return { store, client, apiKey, call, cookieValue, handle }
})

interface Gateway {
  readonly call: (
    method: string,
    pathname: string,
    init?: CallInit
  ) => Effect.Effect<CallResult>
  readonly cookieValue: (setCookie: string | null) => string
}

const signupHuman = Effect.fnUntraced(function*(
  setup_: Gateway,
  email = "sebastian@example.com",
  password = "correct horse battery"
) {
  const response = yield* setup_.call("POST", "/v1/auth/signup", {
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
})

const googleIdentity = (): GoogleIdentityOAuth => ({
  clientId: "google-client",
  clientSecret: "google-secret",
  publicUrlOf: () => "http://gateway.test"
})

const googleHttpClient = FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(
  FetchHttpClient.Fetch,
  Object.assign(
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
)))

const oauthStateFrom = (response: Response): string => {
  const location = response.headers.get("location")
  if (location === null) throw new Error("Google redirect did not contain a location")
  const state = new URL(location).searchParams.get("state")
  if (state === null) throw new Error("Google redirect did not contain state")
  return state
}

describe("signup", () => {
  it.effect("the first human claims a fresh tenant and a live session", () =>
    Effect.gen(function*() {
    const setup_ = yield* setup({ signupOpen: true })
    const human = yield* signupHuman(setup_)

    const logins = yield* setup_.store.countLogins()
    expect(logins).toBe(1)
    const tenant = yield* setup_.store.findTenantById(TenantId.make(human.tenantId))
    expect(tenant).toBeDefined()
    const subjects = yield* setup_.store.listSubjects(TenantId.make(human.tenantId))
    expect(subjects).toHaveLength(1)
    expect(human.cookie).toMatch(/^wfs_/)

    const me = yield* setup_.call("GET", "/v1/auth/me", { cookie: human.cookie })
    expect(me.body["authenticated"]).toBe(true)
    expect(me.body["kind"]).toBe("session")
    expect(me.body["email"]).toBe(human.email)
    expect(me.body["tenantId"]).toBe(human.tenantId)
    expect(me.body["subjectId"]).toBe(subjects[0]?.id)
    }).pipe(Effect.provide(testServices)))

  it.effect("rechecks whether signup is open for every account creation", () =>
    Effect.gen(function*() {
    let open = true
    const setup_ = yield* setup({ signupOpenOf: async () => open })
    yield* signupHuman(setup_)
    open = false

    const response = yield* setup_.call("POST", "/v1/auth/signup", {
      body: { email: "second@example.com", password: "correct horse battery" },
      headers: { origin: "http://gateway.test", "sec-fetch-site": "same-origin" }
    })

    expect(response.status).toBe(403)
    expect(response.body["code"]).toBe("signup-closed")
    const providers = yield* setup_.call("GET", "/v1/auth/providers")
    expect(providers.body["signupOpen"]).toBe(false)
    }).pipe(Effect.provide(testServices)))

  it.effect("is closed unless asked otherwise", () =>
    Effect.gen(function*() {
    const setup_ = yield* setup({ signupOpen: false })
    const response = yield* setup_.call("POST", "/v1/auth/signup", {
      body: { email: "sebastian@example.com", password: "correct horse battery" }
    })
    expect(response.status).toBe(403)
    expect(response.body["code"]).toBe("signup-closed")
    }).pipe(Effect.provide(testServices)))

  it.effect("rejects a short password and a malformed email at the boundary", () =>
    Effect.gen(function*() {
    const setup_ = yield* setup({ signupOpen: true })
    const short = yield* setup_.call("POST", "/v1/auth/signup", {
      body: { email: "a@example.com", password: "short" }
    })
    expect(short.status).toBe(400)
    const malformed = yield* setup_.call("POST", "/v1/auth/signup", {
      body: { email: "not-an-email", password: "correct horse battery" }
    })
    expect(malformed.status).toBe(400)
    }).pipe(Effect.provide(testServices)))

  it.effect("does not mint a second account for a taken email", () =>
    Effect.gen(function*() {
    const setup_ = yield* setup({ signupOpen: true })
    const first = yield* signupHuman(setup_)
    const second = yield* setup_.call("POST", "/v1/auth/signup", {
      body: { email: first.email, password: "another passphrase here" }
    })
    expect(second.status).toBe(400)
    expect(String(second.body["error"])).toContain("already exists")
    }).pipe(Effect.provide(testServices)))
})

describe("login", () => {
  it.effect("accepts the credentials it issued", () =>
    Effect.gen(function*() {
    const setup_ = yield* setup({ signupOpen: true })
    const human = yield* signupHuman(setup_)

    const login = yield* setup_.call("POST", "/v1/auth/login", {
      body: { email: human.email, password: human.password }
    })

    expect(login.status).toBe(200)
    expect(login.setCookie).toContain("wf_session=wfs_")
    }).pipe(Effect.provide(testServices)))

  it.effect("answers the same for unknown email and wrong password", () =>
    Effect.gen(function*() {
    const setup_ = yield* setup({ signupOpen: true })
    const human = yield* signupHuman(setup_)

    const wrongPassword = yield* setup_.call("POST", "/v1/auth/login", {
      body: { email: human.email, password: "not the passphrase" }
    })
    const unknownEmail = yield* setup_.call("POST", "/v1/auth/login", {
      body: { email: "nobody@example.com", password: "whatever goes here" }
    })

    expect(wrongPassword.status).toBe(401)
    expect(unknownEmail.status).toBe(401)
    expect(wrongPassword.body["error"]).toBe(unknownEmail.body["error"])
    expect(wrongPassword.body["code"]).toBe("invalid-credentials")
    }).pipe(Effect.provide(testServices)))
})

describe("Google identity and CLI handoff", () => {
  it.effect("signs ii in through a one-time browser handoff", () =>
    Effect.gen(function*() {
    const setup_ = yield* setup({ signupOpen: true, google: googleIdentity() })
    const providers = yield* setup_.call("GET", "/v1/auth/providers")
    expect(providers.body["google"]).toEqual({
      enabled: true,
      startUrl: "/v1/auth/google/start",
      callbackUrl: "http://gateway.test/v1/auth/google/callback"
    })
    expect(providers.body["signupOpen"]).toBe(true)

    const handoff = yield* setup_.call("POST", "/v1/auth/cli/start")
    expect(handoff.status).toBe(201)
    const requestId = String(handoff.body["requestId"])
    expect(requestId).toMatch(/^wfl_/)

    const start = yield* Effect.promise(() => setup_.handle(new Request(String(handoff.body["authorizationUrl"]))))
    expect(start.status).toBe(302)
    const callback = yield* Effect.promise(() => setup_.handle(new Request(
      `http://gateway.test/v1/auth/google/callback?state=${encodeURIComponent(oauthStateFrom(start))}&code=code-1`
    )))
    expect(callback.status).toBe(200)
    expect(yield* Effect.promise(() => callback.text())).toContain("The terminal is authenticated")

    const collected = yield* setup_.call("GET", `/v1/auth/cli/${encodeURIComponent(requestId)}`)
    expect(collected.body["status"]).toBe("authenticated")
    expect(collected.body["email"]).toBe("google@example.com")
    const token = String(collected.body["token"])
    expect(token).toMatch(/^wfs_/)
    const replay = yield* setup_.call("GET", `/v1/auth/cli/${encodeURIComponent(requestId)}`)
    expect(replay.status).toBe(410)

    const me = yield* setup_.call("GET", "/v1/auth/me", { cookie: token })
    expect(me.body["hasPassword"]).toBe(false)
    expect(me.body["identityProviders"]).toEqual(["google"])
    const passwordLogin = yield* setup_.call("POST", "/v1/auth/login", {
      body: { email: "google@example.com", password: "not configured" }
    })
    expect(passwordLogin.status).toBe(401)

    const added = yield* setup_.call("POST", "/v1/auth/password", {
      body: { newPassword: "new correct horse battery" },
      cookie: token,
      headers: { origin: "http://gateway.test", "sec-fetch-site": "same-origin" }
    })
    expect(added.status).toBe(200)
    const after = yield* setup_.call("POST", "/v1/auth/login", {
      body: { email: "google@example.com", password: "new correct horse battery" }
    })
    expect(after.status).toBe(200)
    }).pipe(Effect.provide(testServices)))

  it.effect("returns a dashboard sign-in to a safe local path", () =>
    Effect.gen(function*() {
    const setup_ = yield* setup({ signupOpen: true, google: googleIdentity() })
    const start = yield* Effect.promise(() => setup_.handle(new Request(
      "http://gateway.test/v1/auth/google/start?returnTo=%2Fapprovals%3Fapproval%3Dap_1"
    )))
    const callback = yield* Effect.promise(() => setup_.handle(new Request(
      `http://gateway.test/v1/auth/google/callback?state=${encodeURIComponent(oauthStateFrom(start))}&code=code-2`
    )))
    expect(callback.status).toBe(302)
    expect(callback.headers.get("location")).toBe("/approvals?approval=ap_1")
    expect(callback.headers.get("set-cookie")).toContain("wf_session=wfs_")

    const unsafeStart = yield* Effect.promise(() => setup_.handle(new Request(
      "http://gateway.test/v1/auth/google/start?returnTo=%2F%2Fevil.example"
    )))
    const unsafeCallback = yield* Effect.promise(() => setup_.handle(new Request(
      `http://gateway.test/v1/auth/google/callback?state=${encodeURIComponent(oauthStateFrom(unsafeStart))}&code=code-3`
    )))
    expect(unsafeCallback.headers.get("location")).toBe("/")
    }).pipe(Effect.provide(testServices)))
})

describe("what a session may do", () => {
  it.effect("reads administrative surfaces without holding any API key", () =>
    Effect.gen(function*() {
    const setup_ = yield* setup({ signupOpen: true })
    const human = yield* signupHuman(setup_)

    const clients = yield* setup_.call("GET", "/v1/clients", { cookie: human.cookie })
    expect(clients.status).toBe(200)

    const audit = yield* setup_.call("GET", "/v1/audit", { cookie: human.cookie })
    expect(audit.status).toBe(200)
    expect(audit.body["total"]).toBe(0)
    }).pipe(Effect.provide(testServices)))

  it.effect("never reaches the delegated surface — delegation needs a key", () =>
    Effect.gen(function*() {
    const setup_ = yield* setup({ signupOpen: true })
    const human = yield* signupHuman(setup_)

    const tools = yield* setup_.call("GET", "/v1/tools", { cookie: human.cookie })
    expect(tools.status).toBe(403)
    expect(tools.body["code"]).toBe("not-permitted")
    expect(tools.body["message"]).toBe("This credential does not hold the required permission")

    const execute = yield* setup_.call("POST", "/v1/execute", {
      body: { alias: "org_gmail_work", tool: "sendEmail" },
      cookie: human.cookie,
      headers: { origin: "http://gateway.test", "sec-fetch-site": "same-origin" }
    })
    expect(execute.status).toBe(403)
    }).pipe(Effect.provide(testServices)))

  it.effect("connects an integration on its own authority, holding no API key", () =>
    Effect.gen(function*() {
    const created: Array<{ readonly integration: string; readonly name: string }> = []
    const integrationServices = stubIntegrationsContext({
      findIntegration: (slug) => Effect.succeed(slug !== "gmail" ? Option.none() : Option.some({
        slug: IntegrationSlug.make("gmail"),
        name: "Gmail",
        description: "Mail",
        kind: "openapi" as const,
        canRemove: true,
        canRefresh: true,
        authMethods: [{ id: "token", label: "API token", kind: "apikey" as const, template: "token" }]
      })),
      createConnection: (input) => Effect.sync(() => {
        created.push({ integration: input.integration, name: input.name })
        return {
          owner: "org" as const,
          name: input.name,
          integration: input.integration,
          template: "token",
          address: `tools.${input.integration}.org.${input.name}`,
          provider: input.integration,
          status: "connected" as const
        }
      })
    })
    const setup_ = yield* setup({ signupOpen: true, integrationServices })
    const human = yield* signupHuman(setup_)

    const response = yield* setup_.call("POST", "/v1/connections", {
      body: { integration: "gmail", connection: "work", values: { token: "secret" } },
      cookie: human.cookie,
      headers: { origin: "http://gateway.test", "sec-fetch-site": "same-origin" }
    })

    expect(response.status).toBe(201)
    expect(created).toEqual([{ integration: "gmail", name: "work" }])
    }).pipe(Effect.provide(testServices)))

  it.effect("is scoped to its own tenant", () =>
    Effect.gen(function*() {
    const setup_ = yield* setup({ signupOpen: true })
    const human = yield* signupHuman(setup_)
    expect(String((human.tenantId))).not.toBe(defaultTenantId)

    const clients = Schema.decodeUnknownSync(
      Schema.Array(Schema.Record(Schema.String, Schema.Json))
    )(
      (yield* setup_.call("GET", "/v1/clients", { cookie: human.cookie })).body["clients"]
    )
    expect(clients).toHaveLength(0)
    }).pipe(Effect.provide(testServices)))
})

describe("cross-site protection for cookie-carried authority", () => {
  it.effect("blocks a write with neither Origin nor Sec-Fetch-Site", () =>
    Effect.gen(function*() {
    const setup_ = yield* setup({ signupOpen: true })
    const human = yield* signupHuman(setup_)

    const response = yield* setup_.call("POST", "/v1/clients", {
      body: { name: "from-another-site" },
      cookie: human.cookie
    })
    expect(response.status).toBe(403)
    expect(response.body["code"]).toBe("cross-site")
    expect(response.body["message"]).toBe("Cross-site requests are not permitted")
    }).pipe(Effect.provide(testServices)))

  it.effect("blocks a write whose Origin names another site", () =>
    Effect.gen(function*() {
    const setup_ = yield* setup({ signupOpen: true })
    const human = yield* signupHuman(setup_)

    const response = yield* setup_.call("POST", "/v1/clients", {
      body: { name: "from-another-site" },
      cookie: human.cookie,
      headers: { origin: "https://evil.example" }
    })
    expect(response.status).toBe(403)
    expect(response.body["code"]).toBe("cross-site")
    }).pipe(Effect.provide(testServices)))

  it.effect("allows a same-origin attested write and exempts reads entirely", () =>
    Effect.gen(function*() {
    const setup_ = yield* setup({ signupOpen: true })
    const human = yield* signupHuman(setup_)

    const write = yield* setup_.call("POST", "/v1/clients", {
      body: { name: "sandbox" },
      cookie: human.cookie,
      headers: { origin: "http://gateway.test", "sec-fetch-site": "same-origin" }
    })
    expect(write.status).toBe(201)

    const read = yield* setup_.call("GET", "/v1/clients", { cookie: human.cookie })
    expect(read.status).toBe(200)
    }).pipe(Effect.provide(testServices)))
})

describe("logout", () => {
  it.effect("revokes the session server-side, not just the cookie", () =>
    Effect.gen(function*() {
    const setup_ = yield* setup({ signupOpen: true })
    const human = yield* signupHuman(setup_)

    const logout = yield* setup_.call("POST", "/v1/auth/logout", {
      cookie: human.cookie,
      headers: { origin: "http://gateway.test", "sec-fetch-site": "same-origin" }
    })
    expect(logout.status).toBe(200)

    const replayed = yield* setup_.call("GET", "/v1/auth/me", { cookie: human.cookie })
    expect(replayed.body).toEqual({ authenticated: false })
    const surface = yield* setup_.call("GET", "/v1/clients", { cookie: human.cookie })
    expect(surface.status).toBe(401)
    }).pipe(Effect.provide(testServices)))

  it.effect("is harmless without a session at all", () =>
    Effect.gen(function*() {
    const setup_ = yield* setup({ signupOpen: true })
    const response = yield* setup_.call("POST", "/v1/auth/logout")
    expect(response.status).toBe(200)
    }).pipe(Effect.provide(testServices)))
})

describe("credential precedence", () => {
  it.effect("an explicit key wins over a valid cookie", () =>
    Effect.gen(function*() {
    const setup_ = yield* setup({ signupOpen: true })
    yield* signupHuman(setup_)
    const me = yield* setup_.call("GET", "/v1/auth/me", {
      cookie: (yield* signupHuman(setup_, "second@example.com")).cookie,
      headers: { authorization: `Bearer ${setup_.apiKey.secret}` }
    })
    expect(me.body["kind"]).toBe("client")
    expect(me.body["clientId"]).toBe(setup_.client.id)
    }).pipe(Effect.provide(testServices)))

  it.effect("a refused key is reported even when a valid cookie sits next to it", () =>
    Effect.gen(function*() {
    const setup_ = yield* setup({ signupOpen: true })
    const human = yield* signupHuman(setup_)

    const response = yield* setup_.call("GET", "/v1/clients", {
      cookie: human.cookie,
      headers: { authorization: "Bearer wfi_not-a-real-key" }
    })
    expect(response.status).toBe(401)
    expect(response.body["code"]).toBe("unknown-key")
    expect(response.body["message"]).toBe("This API key is not known to the server")
    }).pipe(Effect.provide(testServices)))
})

describe("attribution", () => {
  it.effect("an approval decided by a session records the human's email", () =>
    Effect.gen(function*() {
    const setup_ = yield* setup({ signupOpen: true })
    const human = yield* signupHuman(setup_)

    const accessProfile = yield* setup_.store.createAccessProfile({
      id: (yield* newAccessProfileId), tenantId: human.tenantId, name: "support-agent"
    })
    yield* setup_.store.replaceAccessProfileTools(accessProfile.id, [{
      connection,
      tool: ToolName.make("sendEmail")
    }])
    const approvalPolicy = yield* setup_.store.createApprovalPolicy({
      id: (yield* newApprovalPolicyId), tenantId: human.tenantId, name: "support-agent"
    })
    yield* setup_.store.replaceApprovalPolicyTools(approvalPolicy.id, [{
        connection,
        tool: ToolName.make("sendEmail"),
        decision: "require_approval"
      }])
    const client = yield* setup_.store.createClient({
      id: (yield* newClientId),
      tenantId: human.tenantId,
      accessProfileId: accessProfile.id,
      approvalPolicyId: approvalPolicy.id,
      name: "support-agent",
      capabilities: ["provision_connections"]
    })
    const key = (yield* generateApiKey)
    yield* setup_.store.addApiKey({ id: key.id, clientId: client.id, hash: key.hash })

    const frozen = yield* setup_.call("POST", "/v1/execute", {
      body: { alias: "org_gmail_work", tool: "sendEmail", arguments: {} },
      headers: { authorization: `Bearer ${key.secret}` }
    })
    expect(frozen.body["status"]).toBe("pending")
    const approvalId = String(frozen.body["approvalId"])

    const denied = yield* setup_.call("POST", `/v1/approvals/${approvalId}/deny`, {
      body: { decidedBy: "spoofed@example.com" },
      cookie: human.cookie,
      headers: { origin: "http://gateway.test", "sec-fetch-site": "same-origin" }
    })
    expect(denied.status).toBe(200)
    const approval = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(
      denied.body["approval"]
    )
    expect(approval["decidedBy"]).toBe(human.email)
    }).pipe(Effect.provide(testServices)))
})

describe("cookie hardening", () => {
  it.effect("issued cookies are HttpOnly and SameSite=Lax", () =>
    Effect.gen(function*() {
    const setup_ = yield* setup({ signupOpen: true })
    const response = yield* setup_.call("POST", "/v1/auth/signup", {
      body: { email: "hardened@example.com", password: "correct horse battery" },
      headers: { origin: "http://gateway.test", "sec-fetch-site": "same-origin" }
    })
    expect(response.setCookie ?? "").toContain("HttpOnly")
    expect(response.setCookie ?? "").toContain("SameSite=Lax")
    expect((response.setCookie ?? "").includes("; Secure")).toBe(false)
    }).pipe(Effect.provide(testServices)))

  it.effect("a deployment behind TLS marks its cookies Secure", () =>
    Effect.gen(function*() {
    const setup_ = yield* setup({ signupOpen: true, secureCookies: true })
    const response = yield* setup_.call("POST", "/v1/auth/signup", {
      body: { email: "tls@example.com", password: "correct horse battery" },
      headers: { origin: "https://gateway.test", "sec-fetch-site": "same-origin" }
    })
    expect(response.setCookie ?? "").toContain("; Secure")
    }).pipe(Effect.provide(testServices)))
})
