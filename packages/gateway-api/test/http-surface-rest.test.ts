import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { OAuthScopeRequired, whenPresent } from "@integragents/contracts"
import { testServices } from "./fixtures.ts"
import { ConnectionName, defaultTenantId, IntegrationSlug, ProfileId, ToolName } from "./gateway.ts"
import {
  JsonBody,
  JsonRows,
  isApprovalId,
  connection,
  keyFor,
  setup,
  profileWithKey,
  sendEmailOn
} from "./http-support.ts"

describe("gateway http surface", () => {
  it.effect("creates a profile from selected tools, refusing tools the catalog does not offer", () =>
    Effect.gen(function* () {
      const { call, store, profile } = yield* setup({
        tools: [
          { address: "tools.gmail.org.work.sendEmail", name: "sendEmail", owner: "org" },
          { address: "tools.gmail.org.work.getEmail", name: "getEmail", owner: "org", defaultDecision: "allow" }
        ]
      })
      const selected = {
        connection: { owner: "org", integration: "gmail", name: "work" },
        tool: "sendEmail",
        decision: "require_approval"
      }
      const response = yield* call("POST", "/v1/profiles", {
        local: true,
        body: { name: "New assistant", tools: [selected] }
      })
      expect(response.status).toBe(201)
      expect(response.body["capabilities"]).toEqual([])
      const id = String(response.body["id"])
      expect(id).not.toBe(profile.id)
      const tools = yield* call("GET", `/v1/profiles/${id}/tools`, { local: true })
      expect(tools.body["tools"]).toMatchObject([
        { alias: "org___gmail___work", tool: "sendEmail", decision: "require_approval" }
      ])
      expect(yield* store.listProfileTools(profile.id)).toHaveLength(1)
      expect(
        (yield* call("POST", "/v1/profiles", { local: true, body: { name: "New assistant", tools: [selected] } })).body
      ).toMatchObject({ _tag: "AlreadyExists", resource: "profile" })
      expect(
        (yield* call("POST", "/v1/profiles", {
          local: true,
          body: { name: "Unavailable", tools: [{ ...selected, tool: "missing" }] }
        })).body
      ).toMatchObject({ _tag: "NotFound", resource: "tool" })
      expect(yield* store.findProfileByName(defaultTenantId, "Unavailable")).toBeUndefined()
    }).pipe(Effect.provide(testServices))
  )

  it.effect("serves health without a key", () =>
    Effect.gen(function* () {
      const { call } = yield* setup()
      const response = yield* call("GET", "/v1/health", { secret: null })
      expect(response.status).toBe(200)
    }).pipe(Effect.provide(testServices))
  )

  it.effect("requires a key on every other route", () =>
    Effect.gen(function* () {
      const { call } = yield* setup()
      expect((yield* call("GET", "/v1/tools", { secret: null })).status).toBe(401)
    }).pipe(Effect.provide(testServices))
  )

  it.effect("rejects an unknown key with 401 and a key of a revoked profile with 403", () =>
    Effect.gen(function* () {
      const { call, profile, store } = yield* setup()
      expect((yield* call("GET", "/v1/tools", { secret: "igk_nope" })).status).toBe(401)

      yield* store.revokeProfile(defaultTenantId, profile.id)
      const refused = yield* call("GET", "/v1/tools")
      expect(refused.status).toBe(403)
      expect(refused.body["code"]).toBe("profile-revoked")
    }).pipe(Effect.provide(testServices))
  )

  it.effect("lists only the caller's effective tools", () =>
    Effect.gen(function* () {
      const { call } = yield* setup()
      const response = yield* call("GET", "/v1/tools")
      expect(response.status).toBe(200)
      expect(response.body["tools"]).toEqual([
        {
          alias: "user___sebastian___gmail___work",
          tool: "sendEmail",
          connection: { owner: "user", subject: "sebastian", integration: "gmail", name: "work" },
          decision: "allow",
          delegated: false
        }
      ])
    }).pipe(Effect.provide(testServices))
  )

  it.effect("a delegated tool starts a flow bound to the subject when they have not connected", () =>
    Effect.gen(function* () {
      const started: Array<{ readonly subject?: string; readonly connection: string }> = []
      const { call, calls, profile } = yield* setup({
        template: true,
        oauthIntegrations: ["gmail"],
        tools: [{ address: "tools.gmail.user:sebastian.work.sendEmail", name: "sendEmail" }],
        oauthStart: (input) =>
          Effect.sync(() => {
            started.push({ ...whenPresent("subject", input.subject), connection: input.connection })
            return {
              id: "session-1",
              integration: input.integration,
              connection: input.connection,
              ...whenPresent("subject", input.subject),
              request: input,
              state: { status: "pending", authorizationUrl: "https://accounts.example/authorize?state=x" }
            }
          })
      })

      expect((yield* call("GET", "/v1/tools")).body["tools"]).toEqual([])
      const anonymous = yield* call("POST", "/v1/execute", {
        body: { alias: "user___gmail___work", tool: "sendEmail", arguments: { to: "a@b.c" } }
      })
      expect(anonymous.status).toBe(403)

      const secret = yield* keyFor(call, profile.id, "sebastian")
      const tools = yield* call("GET", "/v1/tools", { secret })
      expect(tools.body["tools"]).toEqual([
        {
          alias: "user___gmail___work",
          tool: "sendEmail",
          connection: { owner: "user", integration: "gmail", name: "work" },
          decision: "allow",
          delegated: true,
          readOnly: false,
          destructive: true,
          idempotent: false,
          openWorld: true
        }
      ])

      const first = yield* call("POST", "/v1/execute", {
        secret,
        body: { alias: "user___gmail___work", tool: "sendEmail", arguments: { to: "a@b.c" } }
      })
      expect(first.status).toBe(200)
      expect(first.body["status"]).toBe("authorization-required")
      expect(first.body["subject"]).toBe("sebastian")
      expect(started).toEqual([{ subject: "sebastian", connection: "work" }])
      expect(calls).toHaveLength(0)
    }).pipe(Effect.provide(testServices))
  )

  it.effect("asks for the scopes a refused call needs on top of those the connection holds", () =>
    Effect.gen(function* () {
      const started: Array<{ readonly scopes?: ReadonlyArray<string>; readonly subject?: string }> = []
      const { call } = yield* setup({
        oauthIntegrations: ["gmail"],
        connections: [{ integration: "gmail", name: "work", scope: "mail.read" }],
        tools: [{ address: "tools.gmail.user:sebastian.work.sendEmail", name: "sendEmail" }],
        failWith: new OAuthScopeRequired({ integration: "gmail", connection: "work", scopes: ["mail.send"] }),
        oauthStart: (input) =>
          Effect.sync(() => {
            started.push({
              ...whenPresent("scopes", input.authMethod.oauth?.scopes),
              ...whenPresent("subject", input.subject)
            })
            return {
              id: "session-1",
              integration: input.integration,
              connection: input.connection,
              request: input,
              state: { status: "pending", authorizationUrl: "https://accounts.example/authorize?state=x" }
            }
          })
      })

      const response = yield* call("POST", "/v1/execute", {
        body: { alias: "user___sebastian___gmail___work", tool: "sendEmail", arguments: { to: "a@b.c" } }
      })

      expect(response.body).toMatchObject({
        status: "authorization-required",
        subject: "sebastian",
        scopes: ["mail.read", "mail.send"],
        session: { state: { status: "pending" } }
      })
      expect(started).toEqual([{ scopes: ["mail.read", "mail.send"], subject: "sebastian" }])
    }).pipe(Effect.provide(testServices))
  )

  it.effect("hands a caller without a host a dashboard link to the MCP App its result renders in", () =>
    Effect.gen(function* () {
      const { call, calls } = yield* setup({
        dashboardUrl: "https://gateway.example",
        tools: [{ address: "tools.gmail.user:sebastian.work.sendEmail", name: "sendEmail" }],
        described: { meta: { ui: { resourceUri: "ui://mail/view.html" } } },
        resources: {
          listed: [],
          contents: {
            "ui://mail/view.html": [
              { uri: "ui://mail/view.html", mimeType: "text/html;profile=mcp-app", text: "<p>mail</p>" }
            ]
          }
        }
      })

      const executed = yield* call("POST", "/v1/execute", {
        body: { alias: "user___sebastian___gmail___work", tool: "sendEmail", arguments: { to: "a@b.c" } }
      })
      const app = Schema.decodeUnknownSync(JsonBody)(executed.body["app"])
      const session = String(app["session"])
      expect(app).toMatchObject({
        url: `https://gateway.example/apps/${session}`,
        resourceUri: "ui://user___sebastian___gmail___work/mail/view.html"
      })

      expect((yield* call("GET", `/v1/app-sessions/${session}`)).status).toBe(403)
      const opened = yield* call("GET", `/v1/app-sessions/${session}`, { local: true })
      expect(opened.body).toMatchObject({ tool: "sendEmail", result: { structuredContent: { ok: true } } })

      const view = yield* call("POST", `/v1/app-sessions/${session}/read`, {
        local: true,
        body: { uri: String(app["resourceUri"]) }
      })
      expect(view.body).toMatchObject({ contents: [{ text: "<p>mail</p>", mimeType: "text/html;profile=mcp-app" }] })

      const fromView = yield* call("POST", `/v1/app-sessions/${session}/call`, {
        local: true,
        body: { name: "sendEmail", arguments: { to: "b@c.d" } }
      })
      expect(fromView.body).toMatchObject({ structuredContent: { ok: true } })
      expect(calls).toHaveLength(2)

      yield* call("PUT", `/v1/app-sessions/${session}/context`, {
        local: true,
        body: { structuredContent: { selected: "b@c.d" } }
      })
      yield* call("POST", `/v1/app-sessions/${session}/messages`, {
        local: true,
        body: { content: [{ type: "text", text: "Send it to b@c.d too" }] }
      })
      const notes = yield* call("GET", `/v1/app-sessions/${session}/notes`)
      expect(notes.body).toMatchObject({
        context: { structuredContent: { selected: "b@c.d" } },
        messages: [{ role: "user", content: [{ type: "text", text: "Send it to b@c.d too" }] }]
      })
    }).pipe(Effect.provide(testServices))
  )

  it.effect("a delegated tool runs on the subject's own connection once it exists", () =>
    Effect.gen(function* () {
      const { call, calls, profile } = yield* setup({
        template: true,
        connections: [{ integration: "gmail", name: "work" }],
        tools: [{ address: "tools.gmail.user:sebastian.work.sendEmail", name: "sendEmail" }]
      })

      const response = yield* call("POST", "/v1/execute", {
        secret: yield* keyFor(call, profile.id, "sebastian"),
        body: { alias: "user___gmail___work", tool: "sendEmail", arguments: { to: "a@b.c" } }
      })

      expect(response.status).toBe(200)
      expect(response.body["status"]).toBe("succeeded")
      expect(calls).toEqual([{ address: "tools.gmail.user:sebastian.work.sendEmail", input: { to: "a@b.c" } }])
    }).pipe(Effect.provide(testServices))
  )

  it.effect("filters the caller's tools by integration and connection", () =>
    Effect.gen(function* () {
      const { call, store, profile } = yield* setup()
      const personal = {
        ...connection,
        name: ConnectionName.make("personal")
      }
      const slack = {
        ...connection,
        integration: IntegrationSlug.make("slack"),
        name: ConnectionName.make("team")
      }
      const routes = [
        { connection, tool: ToolName.make("sendEmail"), decision: "allow" as const },
        { connection: personal, tool: ToolName.make("readEmail"), decision: "allow" as const },
        { connection: slack, tool: ToolName.make("postMessage"), decision: "require_approval" as const }
      ]
      yield* store.replaceProfileTools(profile.id, routes)

      const gmail = yield* call("GET", "/v1/tools?integration=gmail")
      expect(Schema.decodeUnknownSync(JsonRows)(gmail.body["tools"]).map((tool) => tool["tool"])).toEqual([
        "readEmail",
        "sendEmail"
      ])

      const work = yield* call("GET", "/v1/tools?integration=gmail&connection=work")
      expect(work.body["tools"]).toMatchObject([
        {
          tool: "sendEmail",
          connection: { integration: "gmail", name: "work" }
        }
      ])
    }).pipe(Effect.provide(testServices))
  )

  it.effect("executes an effective tool against the address built from the profile", () =>
    Effect.gen(function* () {
      const { call, calls } = yield* setup()

      const response = yield* call("POST", "/v1/execute", {
        body: { alias: "user___sebastian___gmail___work", tool: "sendEmail", arguments: { to: "a@b.c" } }
      })

      expect(response.status).toBe(200)
      expect(response.body["status"]).toBe("succeeded")
      expect(calls).toHaveLength(1)
      expect(calls[0]?.address).toBe("tools.gmail.user:sebastian.work.sendEmail")
    }).pipe(Effect.provide(testServices))
  )

  it.effect("answers a retried call with the outcome its idempotency key already got", () =>
    Effect.gen(function* () {
      const { call, calls } = yield* setup()
      const send = (to: string) =>
        call("POST", "/v1/execute", {
          body: {
            alias: "user___sebastian___gmail___work",
            tool: "sendEmail",
            arguments: { to },
            idempotencyKey: "run-1/call-3"
          }
        })

      const first = yield* send("a@b.c")
      const retry = yield* send("a@b.c")
      const reused = yield* send("x@y.z")

      expect([first.status, retry.status, retry.body]).toEqual([200, 200, first.body])
      expect(reused.status).toBe(400)
      expect(reused.body["error"]).toMatchObject({
        _tag: "InvalidInput",
        field: "idempotencyKey",
        problem: expect.stringContaining("run-1/call-3")
      })
      expect(calls).toHaveLength(1)
    }).pipe(Effect.provide(testServices))
  )

  it.effect("refuses an unauthorized tool without calling the vendor", () =>
    Effect.gen(function* () {
      const { call, calls } = yield* setup()

      const response = yield* call("POST", "/v1/execute", {
        body: { alias: "user___sebastian___gmail___work", tool: "deleteEverything" }
      })

      expect(response.status).toBe(403)
      expect(calls).toHaveLength(0)
    }).pipe(Effect.provide(testServices))
  )

  it.effect("freezes a require_approval call instead of performing it", () =>
    Effect.gen(function* () {
      const { call, calls } = yield* setup({ decision: "require_approval" })

      const response = yield* call("POST", "/v1/execute", {
        body: { alias: "user___sebastian___gmail___work", tool: "sendEmail", arguments: { to: "a@b.c" } }
      })

      expect(response.status).toBe(200)
      expect(response.body["status"]).toBe("pending")
      expect(isApprovalId(response.body["approvalId"])).toBe(true)
      expect(calls).toHaveLength(0)
    }).pipe(Effect.provide(testServices))
  )

  it.effect("rejects arguments the tool's schema refuses before freezing an approval", () =>
    Effect.gen(function* () {
      const { call, calls, store } = yield* setup({ decision: "require_approval" })

      const response = yield* call("POST", "/v1/execute", {
        body: { alias: "user___sebastian___gmail___work", tool: "sendEmail", arguments: { to: 5 } }
      })

      expect(response.status).toBe(400)
      expect(response.body["status"]).toBe("invalid")
      expect(response.body["error"]).toMatchObject({
        _tag: "InvalidInput",
        field: "arguments",
        issues: [expect.objectContaining({ path: "to" })]
      })
      expect(calls).toHaveLength(0)
      expect(yield* store.listApprovals(defaultTenantId, "pending")).toHaveLength(0)
    }).pipe(Effect.provide(testServices))
  )

  it.effect("reports a vendor failure as 502 rather than a denial", () =>
    Effect.gen(function* () {
      const { call } = yield* setup({ fail: true })

      const response = yield* call("POST", "/v1/execute", {
        body: { alias: "user___sebastian___gmail___work", tool: "sendEmail", arguments: { to: "a@b.c" } }
      })

      expect(response.status).toBe(502)
      expect(response.body["status"]).toBe("failed")
      expect(response.body["error"]).toMatchObject({
        _tag: "ToolCallFailed",
        tool: "sendEmail",
        reason: "unavailable",
        upstreamStatus: 500,
        mayHaveWritten: true,
        retryable: false,
        hint: "The call may have taken effect; check before repeating it"
      })
    }).pipe(Effect.provide(testServices))
  )

  it.effect("rejects a malformed body at the boundary", () =>
    Effect.gen(function* () {
      const { call } = yield* setup()
      const response = yield* call("POST", "/v1/execute", { body: { alias: "user___sebastian___gmail___work" } })
      expect(response.status).toBe(400)
    }).pipe(Effect.provide(testServices))
  )

  it.effect("provisioning does not imply gateway administration", () =>
    Effect.gen(function* () {
      const { call, profile } = yield* setup({ capabilities: ["provision_connections"] })

      for (const [method, route] of [
        ["GET", "/v1/integrations"],
        ["POST", "/v1/integrations/discover"],
        ["GET", "/v1/connections"]
      ] as const) {
        const response = yield* call(method, route, { body: {} })
        expect(`${route} -> ${response.status}`).not.toBe(`${route} -> 403`)
      }

      for (const [method, route] of [
        ["GET", "/v1/overview"],
        ["GET", "/v1/profiles"],
        ["POST", "/v1/profiles"],
        ["GET", `/v1/profiles/${profile.id}/tools`],
        ["POST", `/v1/profiles/${profile.id}/tools`],
        ["POST", `/v1/profiles/${profile.id}/keys`],
        ["GET", "/v1/approvals"],
        ["GET", "/v1/audit"]
      ] as const) {
        const response = yield* call(method, route, { body: {} })
        expect(`${route} -> ${response.status}`).toBe(`${route} -> 403`)
      }
    }).pipe(Effect.provide(testServices))
  )

  it.effect("permits administrative routes to a key with the administration capability", () =>
    Effect.gen(function* () {
      const { call } = yield* setup({ capabilities: ["provision_connections", "administer_gateway"] })
      expect((yield* call("GET", "/v1/integrations")).status).toBe(200)
      expect((yield* call("GET", "/v1/profiles")).status).toBe(200)
      expect((yield* call("GET", "/v1/audit")).status).toBe(200)
    }).pipe(Effect.provide(testServices))
  )

  it.effect("summarizes dashboard readiness without per-profile requests", () =>
    Effect.gen(function* () {
      const { call } = yield* setup({
        capabilities: ["provision_connections", "administer_gateway"]
      })
      const response = yield* call("GET", "/v1/overview")
      expect(response.status).toBe(200)
      expect(response.body).toEqual({
        connections: 0,
        profiles: 1,
        profileTools: 1,
        keys: 1,
        pendingApprovals: 0,
        recentActivity: []
      })
    }).pipe(Effect.provide(testServices))
  )

  it.effect("does not let one profile read another's frozen call", () =>
    Effect.gen(function* () {
      const { call, store } = yield* setup({ decision: "require_approval" })
      const frozen = yield* call("POST", "/v1/execute", {
        body: { alias: "user___sebastian___gmail___work", tool: "sendEmail", arguments: { to: "a@b.c" } }
      })
      const approvalId = String(frozen.body["approvalId"])

      const other = yield* profileWithKey(store, "someone-else", [sendEmailOn(connection, "require_approval")])

      expect((yield* call("GET", `/v1/approvals/${approvalId}`)).status).toBe(200)
      const peek = yield* call("GET", `/v1/approvals/${approvalId}`, { secret: other.key.secret })
      expect(peek.status).toBe(404)
    }).pipe(Effect.provide(testServices))
  )

  it.effect("issues a named key exactly once and never returns it again", () =>
    Effect.gen(function* () {
      const { call, store } = yield* setup({ capabilities: ["provision_connections", "administer_gateway"] })
      const profileResponse = yield* call("POST", "/v1/profiles", { body: { name: "sandbox" } })
      expect(profileResponse.status).toBe(201)
      const profileId = ProfileId.make(String(profileResponse.body["id"]))

      expect((yield* call("POST", `/v1/profiles/${profileId}/keys`, { body: { name: "  " } })).status).toBe(400)
      const keyResponse = yield* call("POST", `/v1/profiles/${profileId}/keys`, { body: { name: " Cursor " } })
      expect(keyResponse.status).toBe(201)
      expect(keyResponse.body).toMatchObject({ profileId, name: "Cursor" })
      const secret = String(keyResponse.body["secret"])
      expect(secret).toMatch(/^igk_/)

      const stored = yield* store.listApiKeys(profileId)
      expect(stored.map((key) => key.name)).toEqual(["Cursor"])
      expect(JSON.stringify(stored)).not.toContain(secret)
    }).pipe(Effect.provide(testServices))
  )

  it.effect("manages reusable approval destinations and profile assignments", () =>
    Effect.gen(function* () {
      const { call } = yield* setup({ capabilities: ["provision_connections", "administer_gateway"] })
      const createdProfile = yield* call("POST", "/v1/profiles", { body: { name: "notified" } })
      const profileId = String(createdProfile.body["id"])
      const created = yield* call("POST", "/v1/approval-destinations", {
        body: { name: "phone", url: "https://notify.example/approvals" }
      })
      expect(created.status).toBe(201)
      expect(String(created.body["signingSecret"])).toMatch(/^igs_/)
      const destination = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(created.body["destination"])
      const destinationId = destination.id
      const assigned = yield* call("POST", `/v1/profiles/${profileId}/approval-destinations`, {
        body: { destinationIds: [destinationId] }
      })
      expect(assigned.body["destinationIds"]).toEqual([destinationId])
      const listed = yield* call("GET", "/v1/approval-destinations")
      expect(listed.body["destinations"]).toHaveLength(1)
    }).pipe(Effect.provide(testServices))
  )

  it.effect("issues a key only for a person the profile acts for", () =>
    Effect.gen(function* () {
      const { call } = yield* setup({ capabilities: ["provision_connections", "administer_gateway"] })
      const created = yield* call("POST", "/v1/profiles", { body: { name: "alice-only", subjects: ["alice"] } })
      const id = String(created.body["id"])
      yield* call("POST", "/v1/subjects", { body: { id: "alice" } })
      yield* call("POST", "/v1/subjects", { body: { id: "bob" } })
      const issue = (subject: string) =>
        call("POST", `/v1/profiles/${id}/keys`, { body: { name: "assistant", subject } })

      expect((yield* issue("alice")).body["subject"]).toBe("alice")
      expect((yield* issue("bob")).status).toBe(400)
      expect((yield* issue("nobody")).status).toBe(404)
    }).pipe(Effect.provide(testServices))
  )

  it.effect("sets how long calls wait and who a profile acts for, keeping both when a client leaves them out", () =>
    Effect.gen(function* () {
      const { call } = yield* setup({ capabilities: ["provision_connections", "administer_gateway"] })
      const created = yield* call("POST", "/v1/profiles", {
        body: { name: "vm-bot", approvalExpiryMinutes: null, subjects: ["alice"] }
      })
      expect(created.status).toBe(201)
      expect([created.body["approvalExpiryMinutes"], created.body["subjects"]]).toEqual([null, ["alice"]])
      const id = String(created.body["id"])

      const untouched = yield* call("POST", `/v1/profiles/${id}/settings`, {
        body: {
          capabilities: [],
          approvalMethod: "link",
          mcpSurface: "tools",
          approvalGroupWindowMinutes: 0,
          includeNewTools: false
        }
      })
      const changed = yield* call("POST", `/v1/profiles/${id}/settings`, {
        body: {
          capabilities: [],
          approvalMethod: "link",
          mcpSurface: "tools",
          approvalGroupWindowMinutes: 0,
          includeNewTools: false,
          approvalExpiryMinutes: 60,
          subjects: "any"
        }
      })

      expect([untouched.body["approvalExpiryMinutes"], untouched.body["subjects"]]).toEqual([null, ["alice"]])
      expect([changed.body["approvalExpiryMinutes"], changed.body["subjects"]]).toEqual([60, "any"])
    }).pipe(Effect.provide(testServices))
  )

  it.effect("copies a profile into one that changes independently of its source", () =>
    Effect.gen(function* () {
      const { call, store, profile } = yield* setup({
        decision: "require_approval",
        capabilities: ["provision_connections", "administer_gateway"],
        mcpSurface: "discovery"
      })
      const destination = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(
        (yield* call("POST", "/v1/approval-destinations", {
          body: { name: "phone", url: "https://notify.example/approvals" }
        })).body["destination"]
      )
      yield* call("POST", `/v1/profiles/${profile.id}/approval-destinations`, {
        body: { destinationIds: [destination.id] }
      })

      const copied = yield* call("POST", "/v1/profiles", { body: { name: "copy", copyFrom: profile.id } })
      expect(copied.status).toBe(201)
      expect(copied.body).toMatchObject({ capabilities: profile.capabilities, mcpSurface: "discovery" })
      const copyId = ProfileId.make(String(copied.body["id"]))
      expect((yield* call("GET", `/v1/profiles/${copyId}/approval-destinations`)).body["destinationIds"]).toEqual([
        destination.id
      ])
      expect((yield* store.listProfileTools(copyId)).map(({ tool, decision }) => ({ tool, decision }))).toEqual([
        { tool: "sendEmail", decision: "require_approval" }
      ])

      const replaced = yield* call("POST", `/v1/profiles/${copyId}/tools`, {
        body: {
          tools: [
            {
              connection: { owner: "user", subject: "sebastian", integration: "gmail", name: "work" },
              tool: "sendEmail",
              decision: "allow"
            }
          ]
        }
      })
      expect(replaced.status).toBe(200)
      yield* call("POST", `/v1/profiles/${copyId}/approval-destinations`, { body: { destinationIds: [] } })

      expect((yield* store.listProfileTools(profile.id)).map(({ decision }) => decision)).toEqual(["require_approval"])
      expect((yield* call("GET", `/v1/profiles/${profile.id}/approval-destinations`)).body["destinationIds"]).toEqual([
        destination.id
      ])
      expect((yield* call("POST", "/v1/profiles", { body: { name: "orphan", copyFrom: "missing" } })).status).toBe(404)
    }).pipe(Effect.provide(testServices))
  )

  it.effect("streams what changed to a dashboard following /v1/events", () =>
    Effect.gen(function* () {
      const { call, handle, key } = yield* setup({
        decision: "require_approval",
        capabilities: ["provision_connections", "administer_gateway"]
      })
      const response = yield* Effect.promise(() =>
        handle(new Request("http://gateway.test/v1/events", { headers: { authorization: `Bearer ${key.secret}` } }))
      )
      expect(response.headers.get("content-type")).toContain("text/event-stream")
      const reader = response.body?.getReader()
      if (reader === undefined) throw new Error("/v1/events answered without a body")
      const decoder = new TextDecoder()
      let received = ""
      const readUntil = (fragment: string) =>
        Effect.promise(async () => {
          while (!received.includes(fragment)) {
            const chunk = await reader.read()
            if (chunk.done) throw new Error(`/v1/events ended before ${fragment}: ${received}`)
            received += decoder.decode(chunk.value)
          }
        }).pipe(Effect.timeout("5 seconds"))

      yield* readUntil(`"_tag":"Connected"`)
      const frozen = yield* call("POST", "/v1/execute", {
        body: { alias: "user___sebastian___gmail___work", tool: "sendEmail", arguments: { to: "a@b.c" } }
      })
      yield* readUntil(`"resource":"approvals","ids":["${String(frozen.body["approvalId"])}"]`)
      yield* readUntil(`"resource":"audit"`)
      yield* Effect.promise(() => reader.cancel())
    }).pipe(Effect.provide(testServices))
  )

  it.effect("returns an authenticated dashboard link with a pending invocation", () =>
    Effect.gen(function* () {
      const { call } = yield* setup({
        decision: "require_approval",
        dashboardUrl: "https://gateway.example"
      })
      const response = yield* call("POST", "/v1/execute", {
        body: { alias: "user___sebastian___gmail___work", tool: "sendEmail", arguments: { to: "a@b.c" } }
      })
      expect(response.body["approvalUrl"]).toBe(
        `https://gateway.example/approvals?approval=${String(response.body["approvalId"])}`
      )
    }).pipe(Effect.provide(testServices))
  )

  it.effect("revoking a profile through the API cancels its frozen calls", () =>
    Effect.gen(function* () {
      const { call, profile } = yield* setup({
        decision: "require_approval",
        capabilities: ["provision_connections", "administer_gateway"]
      })
      yield* call("POST", "/v1/execute", {
        body: { alias: "user___sebastian___gmail___work", tool: "sendEmail", arguments: { to: "a@b.c" } }
      })

      const response = yield* call("POST", `/v1/profiles/${profile.id}/revoke`, { body: {} })

      expect(response.status).toBe(200)
      expect(response.body["cancelledApprovals"]).toBe(1)
    }).pipe(Effect.provide(testServices))
  )
})
