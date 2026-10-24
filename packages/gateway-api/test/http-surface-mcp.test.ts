import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Schedule, Schema, Stream } from "effect"
import { blobHandleKey, OAuthScopeRequired, whenPresentMap } from "@integragents/contracts"
import { BlobStore } from "@integragents/integrations"
import { SkillsClient } from "@modelcontextprotocol/client/ext/skills"
import { testServices } from "./fixtures.ts"
import { defaultTenantId, ToolName } from "./gateway.ts"
import { connection, keyFor, setup, mcpText, mcpClient, mcpJson, JsonBody, rawMcp } from "./http-support.ts"

const decodeStructuredError = Schema.decodeUnknownSync(
  Schema.Struct({ structuredContent: Schema.Struct({ error: Schema.Json }) })
)
const structuredErrorOf = <A>(result: A) => decodeStructuredError(result).structuredContent.error

describe("gateway http surface", () => {
  it.effect("serves each API key's effective tools over MCP", () =>
    Effect.gen(function* () {
      const { handle, key, calls } = yield* setup()
      const client = yield* mcpClient(handle, key.secret)

      const listed = yield* Effect.promise(() => client.listTools())
      expect(listed.tools).toContainEqual(
        expect.objectContaining({
          name: "user___sebastian___gmail___work__sendEmail",
          description: "Send an email",
          inputSchema: expect.objectContaining({ type: "object" })
        })
      )
      expect(listed.tools.map((tool) => tool.name)).not.toContain("execute")

      const called = yield* Effect.promise(() =>
        client.callTool({
          name: "user___sebastian___gmail___work__sendEmail",
          arguments: { to: "a@b.c" }
        })
      )
      expect(called.isError).not.toBe(true)
      expect(calls).toEqual([
        {
          address: "tools.gmail.user:sebastian.work.sendEmail",
          input: { to: "a@b.c" }
        }
      ])
    }).pipe(Effect.provide(testServices))
  )

  it.effect("shows a delegated tool only to a credential bound to a person, and runs it on their connection", () =>
    Effect.gen(function* () {
      const { handle, key, call, calls, profile } = yield* setup({
        template: true,
        connections: [{ integration: "gmail", name: "work" }],
        tools: [{ address: "tools.gmail.user:sebastian.work.sendEmail", name: "sendEmail" }]
      })
      const unbound = yield* mcpClient(handle, key.secret)
      expect((yield* Effect.promise(() => unbound.listTools())).tools.map((tool) => tool.name)).not.toContain(
        "user___gmail___work__sendEmail"
      )

      const bound = yield* mcpClient(handle, yield* keyFor(call, profile.id, "sebastian"))
      const called = yield* Effect.promise(() =>
        bound.callTool({ name: "user___gmail___work__sendEmail", arguments: { to: "a@b.c" } })
      )
      expect(called.isError).not.toBe(true)
      expect(calls).toEqual([{ address: "tools.gmail.user:sebastian.work.sendEmail", input: { to: "a@b.c" } }])
    }).pipe(Effect.provide(testServices))
  )

  it.effect("tells an MCP client what the tool's source says about it", () =>
    Effect.gen(function* () {
      const { handle, key } = yield* setup({
        tools: [{ address: "tools.gmail.user:sebastian.work.sendEmail", name: "sendEmail" }]
      })
      const client = yield* mcpClient(handle, key.secret)

      const listed = yield* Effect.promise(() => client.listTools())

      expect(
        listed.tools.find((tool) => tool.name === "user___sebastian___gmail___work__sendEmail")?.annotations
      ).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true })
    }).pipe(Effect.provide(testServices))
  )

  it.effect("passes on a tool's own title, output schema and metadata, then its structured result and media", () =>
    Effect.gen(function* () {
      const blobs = yield* BlobStore
      const stored = yield* blobs.write(
        { contentType: "image/png", filename: undefined },
        Stream.succeed(new TextEncoder().encode("png bytes"))
      )
      const image = {
        [blobHandleKey]: stored.id,
        bytes: stored.bytes,
        contentType: "image/png",
        sha256: stored.sha256,
        note: "binary"
      }
      const outputSchema = { type: "object", properties: { id: { type: "string" } } }
      const { handle, key } = yield* setup({
        tools: [{ address: "tools.gmail.user:sebastian.work.sendEmail", name: "sendEmail" }],
        described: {
          title: "Send an email",
          outputSchema,
          icons: [{ src: "https://mail.example/icon.png", mimeType: "image/png" }],
          meta: { "com.example/priority": "high" }
        },
        execution: {
          kind: "complete",
          result: { id: "message-1" },
          attachments: [{ type: "image", blob: image }]
        },
        blobs
      })
      const client = yield* mcpClient(handle, key.secret)

      const listed = (yield* Effect.promise(() => client.listTools())).tools.find(
        (tool) => tool.name === "user___sebastian___gmail___work__sendEmail"
      )
      expect(listed).toMatchObject({
        title: "Send an email (gmail / work)",
        outputSchema,
        icons: [{ src: "https://mail.example/icon.png", mimeType: "image/png" }],
        _meta: { "com.example/priority": "high" }
      })

      const called = yield* Effect.promise(() =>
        client.callTool({ name: "user___sebastian___gmail___work__sendEmail", arguments: { to: "a@b.c" } })
      )
      expect(called.isError).not.toBe(true)
      expect(called.structuredContent).toEqual({ id: "message-1" })
      expect(called.content).toEqual([
        { type: "text", text: '{"id":"message-1"}' },
        { type: "image", data: btoa("png bytes"), mimeType: "image/png" }
      ])
      expect(client.getInstructions()).toContain('profile "support-agent"')
      expect(client.getInstructions()).toContain("(user___sebastian___gmail___work)")
    }).pipe(Effect.provide(Layer.merge(testServices, BlobStore.temporaryLayer)))
  )

  it.effect("cancels the call when the client abandons it, and records that it may have run", () =>
    Effect.gen(function* () {
      const started = Promise.withResolvers<void>()
      const { handle, key, store } = yield* setup({
        beforeExecute: () => {
          started.resolve()
          return new Promise<void>(() => {})
        }
      })
      const client = yield* mcpClient(handle, key.secret, { action: "accept", asked: [] })
      const abandon = new AbortController()

      const call = client
        .callTool(
          { name: "user___sebastian___gmail___work__sendEmail", arguments: { to: "a@b.c" } },
          { signal: abandon.signal }
        )
        .then(
          () => "answered",
          () => "abandoned"
        )
      yield* Effect.promise(() => started.promise)
      abandon.abort()
      expect(yield* Effect.promise(() => call)).toBe("abandoned")

      const cancelled = yield* store.listAudit(defaultTenantId, {}).pipe(
        Effect.map((records) => records.find((record) => record.message?.includes("cancelled by the caller"))),
        Effect.filterOrFail((record) => record !== undefined),
        Effect.retry({ schedule: Schedule.spaced("20 millis"), times: 100 })
      )
      expect(cancelled).toMatchObject({ outcome: "failed", tool: "sendEmail" })
    }).pipe(Effect.provide(testServices))
  )

  it.effect("attributes an MCP call to the key it arrived with and the app that says it made it", () =>
    Effect.gen(function* () {
      const { handle, key, store, profile } = yield* setup()
      const client = yield* mcpClient(handle, key.secret, { action: "accept", asked: [] })

      yield* mcpJson(client, "user___sebastian___gmail___work__sendEmail", { to: "a@b.c" })

      expect(yield* store.listAudit(defaultTenantId, {})).toMatchObject([
        {
          profileId: profile.id,
          outcome: "succeeded",
          caller: {
            apiKeyId: key.id,
            oauthGrantId: null,
            credentialName: "Claude Desktop",
            agent: "gateway-test 1.0.0"
          }
        }
      ])
    }).pipe(Effect.provide(testServices))
  )

  it.effect("offers the agent CLI's commands as MCP tools", () =>
    Effect.gen(function* () {
      const { handle, key, calls, removed } = yield* setup({
        mcpSurface: "discovery",
        connections: [{ integration: "gmail", name: "work" }]
      })
      const client = yield* mcpClient(handle, key.secret)

      const listed = yield* Effect.promise(() => client.listTools())
      expect(listed.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          "search",
          "discover",
          "integrations",
          "connect",
          "oauth_status",
          "connections",
          "disconnect",
          "tools",
          "schema",
          "execute",
          "validate",
          "approval"
        ])
      )

      const tools = yield* mcpJson(client, "tools", { integration: "gmail" })
      expect(tools["tools"]).toEqual([
        {
          alias: "user___sebastian___gmail___work",
          tool: "sendEmail",
          decision: "allow",
          description: "Send an email"
        }
      ])

      const schema = yield* mcpJson(client, "schema", { alias: "user___sebastian___gmail___work", tool: "sendEmail" })
      expect(schema["inputSchema"]).toMatchObject({ type: "object" })

      const executed = yield* mcpJson(client, "execute", {
        alias: "user___sebastian___gmail___work",
        tool: "sendEmail",
        arguments: { to: "a@b.c" }
      })
      expect(executed).toEqual({ ok: true })
      expect(calls).toEqual([{ address: "tools.gmail.user:sebastian.work.sendEmail", input: { to: "a@b.c" } }])

      const connections = yield* mcpJson(client, "connections", {})
      expect(connections["connections"]).toMatchObject([{ integration: "gmail", name: "work" }])

      yield* mcpJson(client, "disconnect", { integration: "gmail", connection: "work" })
      expect(removed).toEqual([{ integration: "gmail", name: "work" }])
    }).pipe(Effect.provide(testServices))
  )

  it.effect("keeps provisioning tools off keys that may not provision", () =>
    Effect.gen(function* () {
      const { handle, key } = yield* setup({ capabilities: [], mcpSurface: "discovery" })
      const client = yield* mcpClient(handle, key.secret)

      const names = (yield* Effect.promise(() => client.listTools())).tools.map((tool) => tool.name)
      expect(names).toEqual(expect.arrayContaining(["tools", "schema", "execute", "approval"]))
      expect(names).not.toContain("connect")
      expect(names).not.toContain("discover")
    }).pipe(Effect.provide(testServices))
  )

  it.effect("refuses local file arguments it cannot upload", () =>
    Effect.gen(function* () {
      const { handle, key, calls } = yield* setup()
      const client = yield* mcpClient(handle, key.secret)

      const refused = yield* Effect.promise(() =>
        client.callTool({
          name: "user___sebastian___gmail___work__sendEmail",
          arguments: { to: "a@b.c", attachment: { "@integrations/file": "/tmp/report.pdf" } }
        })
      )
      expect(refused.isError).toBe(true)
      expect(mcpText(refused)).toContain("Code: NotImplemented")
      expect(mcpText(refused)).toContain("POST /v1/blobs")
      expect(calls).toEqual([])
    }).pipe(Effect.provide(testServices))
  )

  it.effect("asks for approval in an MCP client that supports elicitation", () =>
    Effect.gen(function* () {
      const { handle, key, calls, store } = yield* setup({ decision: "require_approval" })
      const asked: Array<string> = []
      const client = yield* mcpClient(handle, key.secret, { action: "accept", asked })

      const result = yield* mcpJson(client, "user___sebastian___gmail___work__sendEmail", { to: "a@b.c" })

      expect(result).toEqual({ ok: true })
      expect(asked).toEqual([expect.stringContaining("user___sebastian___gmail___work.sendEmail")])
      expect(calls).toEqual([{ address: "tools.gmail.user:sebastian.work.sendEmail", input: { to: "a@b.c" } }])
      expect(yield* store.listApprovals(defaultTenantId)).toMatchObject([
        { status: "approved", decidedBy: "Claude Desktop (in-client approval)" }
      ])
    }).pipe(Effect.provide(testServices))
  )

  it.effect("remembers an in-client approval for these exact arguments when the human asks to", () =>
    Effect.gen(function* () {
      const { handle, key, calls, store, profile } = yield* setup({ decision: "require_approval" })
      const asked: Array<string> = []
      const client = yield* mcpClient(handle, key.secret, { action: "accept", asked, content: { remember: true } })

      const first = yield* mcpJson(client, "user___sebastian___gmail___work__sendEmail", { to: "a@b.c" })
      const again = yield* mcpJson(client, "user___sebastian___gmail___work__sendEmail", { to: "a@b.c" })

      expect([first, again]).toEqual([{ ok: true }, { ok: true }])
      expect(asked).toHaveLength(1)
      expect(calls).toHaveLength(2)
      expect(yield* store.listApprovalRules(profile.id)).toMatchObject([
        { pinned: [{ path: ["to"], value: "a@b.c" }], free: [] }
      ])
      expect((yield* store.listAudit(defaultTenantId, {})).map((record) => record.approval)).toContain(
        "approved_always"
      )
    }).pipe(Effect.provide(testServices))
  )

  it.effect("decides nothing when the in-client approval answer carries fields the form did not ask for", () =>
    Effect.gen(function* () {
      const { handle, key, calls, store, profile } = yield* setup({ decision: "require_approval" })
      const client = yield* mcpClient(handle, key.secret, {
        action: "accept",
        asked: [],
        content: { remember: false, to: "attacker@evil.example" }
      })

      const result = yield* Effect.promise(() =>
        client.callTool({ name: "user___sebastian___gmail___work__sendEmail", arguments: { to: "a@b.c" } })
      )

      expect(result.isError).toBe(true)
      expect(mcpText(result)).toContain("does not ask for")
      expect(calls).toEqual([])
      expect(yield* store.listApprovals(defaultTenantId)).toMatchObject([
        { status: "pending", arguments: { to: "a@b.c" } }
      ])
      expect(yield* store.listApprovalRules(profile.id)).toEqual([])
    }).pipe(Effect.provide(testServices))
  )

  it.effect("denies the call when the human declines the in-client approval", () =>
    Effect.gen(function* () {
      const { handle, key, calls } = yield* setup({ decision: "require_approval" })
      const client = yield* mcpClient(handle, key.secret, { action: "decline", asked: [] })

      const result = yield* Effect.promise(() =>
        client.callTool({ name: "user___sebastian___gmail___work__sendEmail", arguments: { to: "a@b.c" } })
      )

      expect(result.isError).toBe(true)
      expect(mcpText(result)).toContain("denied")
      expect(calls).toEqual([])
    }).pipe(Effect.provide(testServices))
  )

  it.effect("returns the approval link when the MCP client cannot elicit or the human dismisses the prompt", () =>
    Effect.gen(function* () {
      const { handle, key, calls } = yield* setup({
        decision: "require_approval",
        dashboardUrl: "https://gateway.example"
      })
      const plain = yield* mcpClient(handle, key.secret)
      const dismissing = yield* mcpClient(handle, key.secret, { action: "cancel", asked: [] })

      for (const client of [plain, dismissing]) {
        const result = yield* Effect.promise(() =>
          client.callTool({ name: "user___sebastian___gmail___work__sendEmail", arguments: { to: "a@b.c" } })
        )
        expect(result.isError).toBe(true)
        const pending = Schema.decodeUnknownSync(JsonBody)(result.structuredContent)
        expect(pending["status"]).toBe("pending")
        const link = `https://gateway.example/approvals?approval=${String(pending["approvalId"])}`
        expect(pending["approvalUrl"]).toBe(link)
        expect(mcpText(result)).toContain(link)
      }
      expect(calls).toEqual([])
    }).pipe(Effect.provide(testServices))
  )

  it.effect("puts the approval link to the human as a URL elicitation, once, when the client can show links", () =>
    Effect.gen(function* () {
      const { handle, key, calls } = yield* setup({
        decision: "require_approval",
        dashboardUrl: "https://gateway.example"
      })
      const opened: Array<string> = []
      const client = yield* mcpClient(handle, key.secret, {
        action: "accept",
        asked: [],
        opened,
        modes: { form: false, url: true }
      })

      const result = yield* Effect.promise(() =>
        client.callTool({ name: "user___sebastian___gmail___work__sendEmail", arguments: { to: "a@b.c" } })
      )

      expect(opened).toEqual([expect.stringMatching(/^https:\/\/gateway\.example\/approvals\?approval=/)])
      expect(result.isError).toBe(true)
      expect(Schema.decodeUnknownSync(JsonBody)(result.structuredContent)).toMatchObject({ status: "pending" })
      expect(calls).toEqual([])
    }).pipe(Effect.provide(testServices))
  )

  it.effect("puts the authorization link a call waits on to the human as a URL elicitation", () =>
    Effect.gen(function* () {
      const opened: Array<string> = []
      const { handle, key } = yield* setup({
        oauthIntegrations: ["gmail"],
        connections: [{ integration: "gmail", name: "work", scope: "mail.read" }],
        tools: [{ address: "tools.gmail.user:sebastian.work.sendEmail", name: "sendEmail" }],
        failWith: new OAuthScopeRequired({ integration: "gmail", connection: "work", scopes: ["mail.send"] }),
        oauthStart: (input) =>
          Effect.succeed({
            id: "session-1",
            integration: input.integration,
            connection: input.connection,
            request: input,
            state: { status: "pending", authorizationUrl: "https://accounts.example/authorize?state=x" }
          })
      })
      const client = yield* mcpClient(handle, key.secret, {
        action: "accept",
        asked: [],
        opened,
        modes: { form: true, url: true }
      })

      const result = yield* Effect.promise(() =>
        client.callTool({ name: "user___sebastian___gmail___work__sendEmail", arguments: { to: "a@b.c" } })
      )

      expect(opened).toEqual(["https://accounts.example/authorize?state=x"])
      expect(Schema.decodeUnknownSync(JsonBody)(result.structuredContent)).toMatchObject({
        status: "authorization-required",
        scopes: ["mail.read", "mail.send"]
      })
    }).pipe(Effect.provide(testServices))
  )

  it.effect("serves each connection's resources under its alias, and the gateway's blobs", () =>
    Effect.gen(function* () {
      const blobs = yield* BlobStore
      const stored = yield* blobs.write(
        { contentType: "application/pdf", filename: "report.pdf" },
        Stream.succeed(new TextEncoder().encode("%PDF"))
      )
      const { handle, key } = yield* setup({
        resources: {
          listed: [
            { uri: "mail://inbox/1", name: "First message", mimeType: "text/plain" },
            { uri: "ui://mail/view.html", name: "Mail view", mimeType: "text/html;profile=mcp-app" }
          ],
          contents: {
            "mail://inbox/1": [{ uri: "mail://inbox/1", mimeType: "text/plain", text: "hello" }],
            "ui://mail/view.html": [
              {
                uri: "ui://mail/view.html",
                mimeType: "text/html;profile=mcp-app",
                text: "<html></html>",
                meta: { ui: { csp: { connectDomains: ["https://mail.example"] } } }
              }
            ]
          }
        },
        blobs
      })
      const client = yield* mcpClient(handle, key.secret, { action: "accept", asked: [] })
      const alias = "user___sebastian___gmail___work"

      const listed = (yield* Effect.promise(() => client.listResources())).resources.map((resource) => resource.uri)
      expect(listed).toEqual([
        `integrations://connections/${alias}/${encodeURIComponent("mail://inbox/1")}`,
        `ui://${alias}/mail/view.html`
      ])

      const message = yield* Effect.promise(() => client.readResource({ uri: listed[0] ?? "" }))
      expect(message.contents).toEqual([{ uri: listed[0], mimeType: "text/plain", text: "hello" }])

      const view = yield* Effect.promise(() => client.readResource({ uri: `ui://${alias}/mail/view.html` }))
      expect(view.contents).toEqual([
        {
          uri: `ui://${alias}/mail/view.html`,
          mimeType: "text/html;profile=mcp-app",
          text: "<html></html>",
          _meta: { ui: { csp: { connectDomains: ["https://mail.example"] } } }
        }
      ])

      const file = yield* Effect.promise(() => client.readResource({ uri: `integrations://blobs/${stored.id}` }))
      expect(file.contents).toEqual([
        { uri: `integrations://blobs/${stored.id}`, mimeType: "application/pdf", blob: btoa("%PDF") }
      ])

      const elsewhere = yield* Effect.promise(() =>
        client.readResource({ uri: "ui://org___github___default/view.html" }).then(
          () => "read",
          () => "refused"
        )
      )
      expect(elsewhere).toBe("refused")
    }).pipe(Effect.provide(Layer.merge(testServices, BlobStore.temporaryLayer)))
  )

  it.effect("describes the MCP endpoint before any credential, in a Server Card an AI Catalog points to", () =>
    Effect.gen(function* () {
      const { handle } = yield* setup({ mcpUrl: "https://gateway.example/mcp" })
      const get = (path: string) =>
        Effect.promise(async () => {
          const response = await handle(new Request(`https://gateway.example${path}`))
          return {
            type: response.headers.get("content-type"),
            body: Schema.decodeUnknownSync(JsonBody)(await response.json())
          }
        })

      const catalog = yield* get("/.well-known/ai-catalog.json")
      expect(catalog).toMatchObject({
        type: "application/ai-catalog+json",
        body: {
          entries: [{ type: "application/mcp-server-card+json", url: "https://gateway.example/mcp/server-card" }]
        }
      })

      const card = yield* get("/mcp/server-card")
      expect(card.type).toBe("application/mcp-server-card+json")
      expect(card.body).toMatchObject({
        name: "io.github.mokronos/integrations",
        remotes: [{ type: "streamable-http", url: "https://gateway.example/mcp" }]
      })
      expect(card.body["remotes"]).toMatchObject([
        { supportedProtocolVersions: expect.arrayContaining(["2026-07-28"]) }
      ])
    }).pipe(Effect.provide(testServices))
  )

  it.effect("tells a listening client when the profile's tools change", () =>
    Effect.gen(function* () {
      const { handle, key, store, profile } = yield* setup()
      const client = yield* mcpClient(handle, key.secret, { action: "accept", asked: [] })
      const changed = Promise.withResolvers<void>()
      client.setNotificationHandler("notifications/tools/list_changed", () => changed.resolve())

      const subscription = yield* Effect.promise(() => client.listen({ toolsListChanged: true }))
      yield* store.replaceProfileTools(profile.id, [
        { connection, tool: ToolName.make("sendEmail"), decision: "require_approval" }
      ])
      yield* Effect.promise(() => changed.promise)
      yield* Effect.promise(() => subscription.close())

      const relisted = (yield* Effect.promise(() => client.listTools())).tools
      expect(relisted.map((tool) => tool.description)).toEqual([expect.stringContaining("held until a human approves")])
    }).pipe(Effect.provide(testServices))
  )

  it.effect("answers a call held for approval as a task the client polls, approves, and collects", () =>
    Effect.gen(function* () {
      const { handle, key, calls, store } = yield* setup({ decision: "require_approval" })
      const send = rawMcp(handle, key.secret, {
        elicitation: { form: {} },
        extensions: { "io.modelcontextprotocol/tasks": {} }
      })

      const created = yield* send("tools/call", {
        name: "user___sebastian___gmail___work__sendEmail",
        arguments: { to: "a@b.c" }
      })
      const task = Schema.decodeUnknownSync(JsonBody)(created["result"])
      expect(task).toMatchObject({ resultType: "task", status: "input_required", pollIntervalMs: 5000 })
      const taskId = String(task["taskId"])
      expect(calls).toEqual([])

      const waiting = Schema.decodeUnknownSync(JsonBody)((yield* send("tasks/get", { taskId }))["result"])
      const inputRequests = Schema.decodeUnknownSync(JsonBody)(waiting["inputRequests"])
      const [requestKey] = Object.keys(inputRequests)
      expect(waiting).toMatchObject({ status: "input_required", resultType: "complete" })

      yield* send("tasks/update", {
        taskId,
        inputResponses: { [requestKey ?? ""]: { action: "accept", content: { remember: false } } }
      })
      expect(calls).toHaveLength(1)

      const done = Schema.decodeUnknownSync(JsonBody)((yield* send("tasks/get", { taskId }))["result"])
      expect(done).toMatchObject({ status: "completed", result: { structuredContent: { ok: true } } })
      expect(yield* store.listApprovals(defaultTenantId)).toMatchObject([{ status: "approved" }])

      const unknown = yield* send("tasks/get", { taskId: "not-a-task" })
      expect(unknown).toMatchObject({ error: { code: -32602 } })

      const undeclared = yield* rawMcp(handle, key.secret, {})("tasks/get", { taskId })
      expect(undeclared).toMatchObject({ error: { code: -32021 } })
    }).pipe(Effect.provide(testServices))
  )

  it.effect("publishes its own skill and each connection's skills in one listing a host can verify", () =>
    Effect.gen(function* () {
      const triage = "---\nname: triage\ndescription: Sort the inbox.\n---\n\nArchive what is old.\n"
      const digest = `sha256:${Array.from(
        new Uint8Array(yield* Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(triage)))),
        (byte) => byte.toString(16).padStart(2, "0")
      ).join("")}`
      const { handle, key } = yield* setup({
        skills: [
          {
            uri: "skill://mail/triage/SKILL.md",
            frontmatter: { name: "triage", description: "Sort the inbox." },
            resources: [{ uri: "skill://mail/triage/SKILL.md", digest, size: new TextEncoder().encode(triage).length }]
          }
        ],
        resources: {
          listed: [],
          contents: { "skill://mail/triage/SKILL.md": [{ uri: "skill://mail/triage/SKILL.md", text: triage }] }
        }
      })
      const client = yield* mcpClient(handle, key.secret, { action: "accept", asked: [] })
      const skills = new SkillsClient(client)

      const listed = (yield* Effect.promise(() => skills.list())).skills
      expect(listed.map((skill) => skill.uri)).toEqual([
        "skill://integrations-gateway/integrations-mcp/SKILL.md",
        "skill://user___sebastian___gmail___work/mail/triage/SKILL.md"
      ])

      const own = yield* Effect.promise(() => skills.read(listed[0]!))
      expect(own).toMatchObject({ verified: true, frontmatter: { name: "integrations-mcp" } })
      const upstream = yield* Effect.promise(() => skills.read(listed[1]!))
      expect(upstream).toMatchObject({ verified: true, body: "\nArchive what is old.\n" })
    }).pipe(Effect.provide(testServices))
  )

  it.effect("points a host that renders MCP Apps at the tool's view through the gateway, and spares others", () =>
    Effect.gen(function* () {
      const listedBy = (
        capabilities: Record<string, typeof Schema.Json.Type>,
        visibility?: ReadonlyArray<"model" | "app">
      ) =>
        Effect.gen(function* () {
          const { handle, key } = yield* setup({
            described: {
              meta: {
                ui: {
                  resourceUri: "ui://mail/view.html",
                  ...whenPresentMap("visibility", visibility, (values) => [...values])
                },
                "com.example/kept": true
              }
            }
          })
          const listed = yield* rawMcp(handle, key.secret, capabilities)("tools/list", {})
          return Schema.decodeUnknownSync(Schema.Array(JsonBody))(
            Schema.decodeUnknownSync(JsonBody)(listed["result"])["tools"]
          ).map((tool) => tool["_meta"])
        })
      const apps = { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } }

      expect(yield* listedBy(apps)).toEqual([
        { "com.example/kept": true, ui: { resourceUri: "ui://user___sebastian___gmail___work/mail/view.html" } }
      ])
      expect(yield* listedBy({})).toEqual([{ "com.example/kept": true }])
      expect(yield* listedBy(apps, ["app"])).toHaveLength(1)
      expect(yield* listedBy({}, ["app"])).toEqual([])
    }).pipe(Effect.provide(testServices))
  )

  it.effect("requires an API key on the MCP endpoint", () =>
    Effect.gen(function* () {
      const { handle } = yield* setup()
      const response = yield* Effect.promise(() =>
        handle(
          new Request("http://gateway.test/mcp", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}"
          })
        )
      )
      expect(response.status).toBe(401)
      expect(response.headers.get("www-authenticate")).toBe("Bearer")
    }).pipe(Effect.provide(testServices))
  )

  it.effect("tells an agent a gateway failure by its trace id, not as an unreadable object", () =>
    Effect.gen(function* () {
      const { handle, key } = yield* setup({ mcpSurface: "discovery", storageFails: true })
      const client = yield* mcpClient(handle, key.secret)

      const failed = yield* Effect.promise(() => client.callTool({ name: "connections", arguments: {} }))

      expect(failed.isError).toBe(true)
      expect(mcpText(failed)).toContain("The gateway could not complete this request")
      expect(mcpText(failed)).toContain("Code: GatewayFailure (HTTP 500)")
      expect(structuredErrorOf(failed)).toMatchObject({ _tag: "GatewayFailure", traceId: expect.any(String) })
    }).pipe(Effect.provide(testServices))
  )

  it.effect("hands an agent the typed error it can act on, in text and in structured form", () =>
    Effect.gen(function* () {
      const { handle, key } = yield* setup({ mcpSurface: "discovery" })
      const client = yield* mcpClient(handle, key.secret)

      const refused = yield* Effect.promise(() =>
        client.callTool({ name: "connect", arguments: { integration: "linear" } })
      )

      expect(refused.isError).toBe(true)
      expect(mcpText(refused)).toContain("Unknown integration linear")
      expect(mcpText(refused)).toContain("Next: Search the registry for it, or register it by URL with discover")
      expect(structuredErrorOf(refused)).toEqual({
        _tag: "NotFound",
        resource: "integration",
        id: "linear",
        message: "Unknown integration linear",
        hint: "Search the registry for it, or register it by URL with discover",
        retryable: false
      })
    }).pipe(Effect.provide(testServices))
  )

  it.effect("reports every argument a tool's schema rejects, by path", () =>
    Effect.gen(function* () {
      const { handle, key, calls } = yield* setup()
      const client = yield* mcpClient(handle, key.secret)

      const refused = yield* Effect.promise(() =>
        client.callTool({ name: "user___sebastian___gmail___work__sendEmail", arguments: {} })
      )

      expect(refused.isError).toBe(true)
      expect(structuredErrorOf(refused)).toMatchObject({
        _tag: "InvalidInput",
        field: "arguments",
        issues: [{ path: "to", message: "is required" }]
      })
      expect(calls).toEqual([])
    }).pipe(Effect.provide(testServices))
  )
})
