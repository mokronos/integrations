import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { testServices } from "./fixtures.ts"
import { defaultTenantId } from "./gateway.ts"
import { setup, mcpText, mcpClient, mcpJson } from "./http-support.ts"

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

  it.effect("tells an MCP client what the tool's source says about it", () =>
    Effect.gen(function* () {
      const { handle, key } = yield* setup({
        tools: [{ address: "tools.gmail.user:sebastian.work.sendEmail", name: "sendEmail" }]
      })
      const client = yield* mcpClient(handle, key.secret)

      const listed = yield* Effect.promise(() => client.listTools())

      expect(
        listed.tools.find((tool) => tool.name === "user___sebastian___gmail___work__sendEmail")?.annotations
      ).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: false })
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
      expect(executed["status"]).toBe("succeeded")
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

      expect(result["status"]).toBe("succeeded")
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

      expect([first["status"], again["status"]]).toEqual(["succeeded", "succeeded"])
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
        const result = yield* mcpJson(client, "user___sebastian___gmail___work__sendEmail", { to: "a@b.c" })
        expect(result["status"]).toBe("pending")
        expect(result["approvalUrl"]).toBe(`https://gateway.example/approvals?approval=${String(result["approvalId"])}`)
      }
      expect(calls).toEqual([])
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
