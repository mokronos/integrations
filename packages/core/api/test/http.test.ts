import { describe, expect, it } from "@effect/vitest"
import { Clock, Effect, Fiber, Option, Schema } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { ToolAddress, whenPresent } from "@integrations/contracts"
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import type { Connection, Tool } from "@integrations/contracts"
import { InvocationError } from "@integrations/integrations"
import { stubIntegrationsContext } from "./stubs.ts"
import { openStore, temporaryDirectory, testServices } from "./fixtures.ts"
import {
  aliasForConnection,
  ApprovalPolicyId,
  ClientId,
  ConnectionName,
  createGatewayHandler,
  defaultTenantId,
  generateApiKey,
  IntegrationSlug,
  newClientId,
  newAccessProfileId,
  newApprovalPolicyId,
  createGatewayStore,
  SubjectId,
  ToolName
} from "./gateway.ts"
import type { ConnectionRef } from "./gateway.ts"

const JsonBody = Schema.Record(Schema.String, Schema.Json)
const JsonRows = Schema.Array(JsonBody)
const isApprovalId = Schema.is(Schema.String)

const connection: ConnectionRef = {
  owner: "user",
  subject: SubjectId.make("sebastian"),
  integration: IntegrationSlug.make("gmail"),
  name: ConnectionName.make("work")
}

interface ExecutedCall {
  readonly address: string
  readonly input: typeof Schema.Json.Type
}

const stubConnection = (
  reference: { readonly integration: string; readonly name: string }
): Connection => ({
  owner: "user",
  name: ConnectionName.make(reference.name),
  integration: IntegrationSlug.make(reference.integration),
  template: reference.integration,
  address: `connections.${reference.integration}.user.${reference.name}`,
  provider: reference.integration,
  status: "connected"
})

const stubTool = (
  tool: {
    readonly address: string
    readonly name: string
    readonly owner?: "org" | "user"
    readonly defaultDecision?: "allow" | "require_approval"
  }
): Tool => ({
  address: ToolAddress.make(tool.address),
  name: ToolName.make(tool.name),
  description: "",
  integration: IntegrationSlug.make("gmail"),
  owner: tool.owner ?? "user",
  connection: ConnectionName.make("work"),
  defaultDecision: tool.defaultDecision ?? "require_approval"
})

const stubIntegrations = (behaviour: {
  readonly beforeExecute?: () => Promise<void>
  readonly fail?: boolean
  readonly connections?: ReadonlyArray<{ readonly integration: string; readonly name: string }>
  readonly tools?: ReadonlyArray<{
    readonly address: string
    readonly name: string
    readonly owner?: "org" | "user"
    readonly defaultDecision?: "allow" | "require_approval"
  }>
} = {}) => {
  const calls: Array<ExecutedCall> = []
  const removed: Array<{ readonly integration: string; readonly name: string }> = []
  const forgotten: Array<string> = []
  const renamed: Array<{ readonly slug: string; readonly name: string }> = []
  const known = new Set((behaviour.connections ?? []).map((connection) => connection.integration))
  const integrationServices = stubIntegrationsContext({
    execute: (address, input) => {
      calls.push({ address: String(address), input })
      return Effect.promise(() => behaviour.beforeExecute?.() ?? Promise.resolve()).pipe(
        Effect.flatMap(() =>
          behaviour.fail === true
            ? Effect.fail(new InvocationError({
              code: "upstream_error",
              detail: "vendor exploded"
            }))
            : Effect.succeed({ ok: true })
        )
      )
    },
    toolSummaries: () => Effect.succeed((behaviour.tools ?? []).map(stubTool)),
    listTools: () => Effect.succeed((behaviour.tools ?? []).map(stubTool)),
    describeTool: (target) => Effect.succeed({
      ...stubTool({
        address: String(target),
        name: String(target).split(".").at(-1) ?? "tool"
      }),
      description: "Send an email",
      inputSchema: {
        type: "object",
        properties: { to: { type: "string" } },
        required: ["to"]
      }
    }),
    listConnections: () => Effect.succeed((behaviour.connections ?? []).map(stubConnection)),
    removeConnection: (reference) => Effect.sync(() => {
      removed.push({ integration: reference.integration, name: reference.name })
    }),
    findIntegration: (slug) => Effect.sync(() =>
      known.has(slug)
        ? Option.some({
          slug,
          name: renamed.find((entry) => entry.slug === slug)?.name ?? String(slug),
          description: "",
          kind: "mcp" as const,
          canRemove: true,
          canRefresh: true,
          authMethods: []
        })
        : Option.none()),
    renameIntegration: (slug, name) => Effect.sync(() => {
      renamed.push({ slug, name })
    }),
    removeIntegration: (slug) => Effect.sync(() => {
      forgotten.push(slug)
    })
  })
  return { calls, removed, forgotten, renamed, integrationServices }
}

const setup = Effect.fnUntraced(function*(options: {
  readonly decision?: "allow" | "require_approval"
  readonly capabilities?: ReadonlyArray<"provision_connections" | "administer_gateway">
  readonly beforeExecute?: () => Promise<void>
  readonly fail?: boolean
  readonly connections?: ReadonlyArray<{ readonly integration: string; readonly name: string }>
  readonly tools?: ReadonlyArray<{
    readonly address: string
    readonly name: string
    readonly owner?: "org" | "user"
    readonly defaultDecision?: "allow" | "require_approval"
  }>
  readonly dashboardUrl?: string
  readonly mcpUrl?: string
} = {}) {
  const store = yield* openStore(yield* temporaryDirectory("gateway-http-"))

  const accessProfile = yield* store.createAccessProfile({
    id: yield* newAccessProfileId,
    tenantId: defaultTenantId,
    name: `access-${crypto.randomUUID()}`
  })
  yield* store.replaceAccessProfileTools(accessProfile.id, [{
    connection,
    tool: ToolName.make("sendEmail")
  }])
  const approvalPolicy = yield* store.createApprovalPolicy({
    id: yield* newApprovalPolicyId,
    tenantId: defaultTenantId,
    name: `approval-${crypto.randomUUID()}`,
    tools: []
  })
  yield* store.replaceApprovalPolicyTools(approvalPolicy.id, [{
    connection,
    tool: ToolName.make("sendEmail"),
    decision: options.decision ?? "allow"
  }])
  const client = yield* store.createClient({
    id: yield* newClientId,
    tenantId: defaultTenantId,
    accessProfileId: accessProfile.id,
    approvalPolicyId: approvalPolicy.id,
    name: "support-agent",
    capabilities: options.capabilities ?? ["provision_connections"]
  })
  const key = yield* generateApiKey
  yield* store.addApiKey({ id: key.id, clientId: client.id, hash: key.hash })
  const stub = stubIntegrations({
    ...whenPresent("beforeExecute", options.beforeExecute),
    ...whenPresent("fail", options.fail),
    ...whenPresent("connections", options.connections),
    ...whenPresent("tools", options.tools)
  })
  const { handle } = createGatewayHandler({
    httpClient: FetchHttpClient.layer,
    store,
    integrationServices: stub.integrationServices,
    retentionDays: 30,
    oauth: {
      start: () => Effect.die(new Error("not used")),
      get: () => Effect.sync((): undefined => undefined),
      completeByState: () => Effect.sync((): undefined => undefined),
      stop: () => Effect.void
    },
    ...whenPresent("dashboardUrl", options.dashboardUrl === undefined
      ? undefined
      : () => options.dashboardUrl),
    ...whenPresent("mcpUrl", options.mcpUrl === undefined
      ? undefined
      : () => options.mcpUrl)
  })

  /** A request as a caller would send it, decoded the way a caller reads it. */
  const call = Effect.fnUntraced(function*(
    method: string,
    pathname: string,
    init: {
      readonly body?: typeof Schema.Json.Type
      readonly secret?: string | null
      readonly local?: boolean
    } = {}
  ) {
    const secret = init.local === true
      ? null
      : init.secret === undefined
        ? key.secret
        : init.secret
    const headers = secret === null
      ? { "content-type": "application/json" }
      : { "content-type": "application/json", authorization: `Bearer ${secret}` }
    const response = yield* Effect.promise(() =>
      handle(
        new Request(`http://gateway.test${pathname}`, {
          method,
          headers,
          ...whenPresent("body", JSON.stringify(init.body))
        }),
        init.local === true ? { localSecret: key.secret } : undefined
      ))
    return {
      status: response.status,
      body: Schema.decodeUnknownSync(JsonBody)(yield* Effect.promise(() => response.json()))
    }
  })

  return {
    store,
    client,
    key,
    accessProfile,
    approvalPolicy,
    handle,
    call,
    calls: stub.calls,
    removed: stub.removed,
    forgotten: stub.forgotten,
    renamed: stub.renamed
  }
})

describe("gateway http surface", () => {
  it.effect("onboarding scopes access to selected tools and fills every approval decision", () =>
    Effect.gen(function*() {
      const { call, store, accessProfile } = yield* setup({
        tools: [
          { address: "tools.gmail.org.work.sendEmail", name: "sendEmail", owner: "org" },
          { address: "tools.gmail.org.work.getEmail", name: "getEmail", owner: "org", defaultDecision: "allow" }
        ]
      })
      const selected = { connection: { owner: "org", integration: "gmail", name: "work" }, tool: "sendEmail", decision: "require_approval" }
      const response = yield* call("POST", "/v1/clients/configured", { local: true, body: { name: "New assistant", tools: [selected] } })
      expect(response.status).toBe(201)
      expect(response.body["capabilities"]).toEqual([])
      expect(response.body["accessProfileId"]).not.toBe(accessProfile.id)
      const id = String(response.body["id"])
      const tools = yield* call("GET", `/v1/clients/${id}/tools`, { local: true })
      expect(tools.body["tools"]).toMatchObject([{ alias: "org_gmail_work", tool: "sendEmail", decision: "require_approval" }])
      const approvalPolicyId = String(response.body["approvalPolicyId"])
      expect((yield* store.listApprovalPolicyTools(ApprovalPolicyId.make(approvalPolicyId))).map((entry) => ({
        tool: entry.tool,
        decision: entry.decision
      }))).toEqual([
        { tool: "getEmail", decision: "allow" },
        { tool: "sendEmail", decision: "require_approval" }
      ])
      expect(yield* store.listAccessProfileTools(accessProfile.id)).toHaveLength(1)
      expect((yield* call("POST", "/v1/clients/configured", { local: true, body: { name: "New assistant", tools: [selected] } })).status).toBe(400)
      expect((yield* call("POST", "/v1/clients/configured", { local: true, body: { name: "Unavailable", tools: [{ ...selected, tool: "missing" }] } })).status).toBe(400)
      expect(yield* store.findClientByName(defaultTenantId, "Unavailable")).toBeUndefined()
    }).pipe(Effect.provide(testServices)))

  it.effect("creates approval policies with a decision for every catalogued tool", () =>
    Effect.gen(function*() {
      const { call, store } = yield* setup({
        tools: [
          { address: "tools.gmail.org.work.getEmail", name: "getEmail", owner: "org", defaultDecision: "allow" },
          { address: "tools.gmail.org.work.sendEmail", name: "sendEmail", owner: "org" }
        ]
      })
      const response = yield* call("POST", "/v1/approval-policies", {
        local: true,
        body: { name: "Filled defaults" }
      })
      expect(response.status).toBe(201)
      const tools = yield* store.listApprovalPolicyTools(
        ApprovalPolicyId.make(String(response.body["id"]))
      )
      expect(tools.map(({ tool, decision }) => ({ tool, decision }))).toEqual([
        { tool: "getEmail", decision: "allow" },
        { tool: "sendEmail", decision: "require_approval" }
      ])
    }).pipe(Effect.provide(testServices)))

  it.effect("serves each API key's effective tools over MCP", () =>
    Effect.gen(function*() {
      const { handle, key, calls } = yield* setup()
      const transport = new StreamableHTTPClientTransport(
        new URL("http://gateway.test/mcp"),
        {
          authProvider: { token: async () => key.secret },
          fetch: (input, init) => handle(new Request(input, init))
        }
      )
      const client = yield* Effect.acquireRelease(
        Effect.promise(async () => {
          const client = new Client({ name: "gateway-test", version: "1.0.0" })
          await client.connect(transport)
          return client
        }),
        (client) => Effect.promise(() => client.close())
      )

      const listed = yield* Effect.promise(() => client.listTools())
      expect(listed.tools).toEqual([expect.objectContaining({
        name: "user_sebastian_gmail_work__sendEmail",
        description: "Send an email",
        inputSchema: expect.objectContaining({ type: "object" })
      })])

      const called = yield* Effect.promise(() =>
        client.callTool({
          name: "user_sebastian_gmail_work__sendEmail",
          arguments: { to: "a@b.c" }
        }))
      expect(called.isError).not.toBe(true)
      expect(calls).toEqual([{
        address: "tools.gmail.user.work.sendEmail",
        input: { to: "a@b.c" }
      }])
    }).pipe(Effect.provide(testServices)))

  it.effect("requires an API key on the MCP endpoint", () =>
    Effect.gen(function*() {
      const { handle } = yield* setup()
      const response = yield* Effect.promise(() =>
        handle(new Request("http://gateway.test/mcp", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}"
        })))
      expect(response.status).toBe(401)
      expect(response.headers.get("www-authenticate")).toBe("Bearer")
    }).pipe(Effect.provide(testServices)))

  it.effect("serves health without a key", () =>
    Effect.gen(function*() {
      const { call } = yield* setup()
      const response = yield* call("GET", "/v1/health", { secret: null })
      expect(response.status).toBe(200)
    }).pipe(Effect.provide(testServices)))

  it.effect("requires a key on every other route", () =>
    Effect.gen(function*() {
      const { call } = yield* setup()
      expect((yield* call("GET", "/v1/tools", { secret: null })).status).toBe(401)
    }).pipe(Effect.provide(testServices)))

  it.effect("rejects an unknown key with 401 and a revoked client with 403", () =>
    Effect.gen(function*() {
      const { call, client, store } = yield* setup()
      expect((yield* call("GET", "/v1/tools", { secret: "wfi_nope" })).status).toBe(401)

      yield* store.revokeClient(defaultTenantId, client.id)
      expect((yield* call("GET", "/v1/tools")).status).toBe(403)
    }).pipe(Effect.provide(testServices)))

  it.effect("lists only the caller's effective tools", () =>
    Effect.gen(function*() {
      const { call } = yield* setup()
      const response = yield* call("GET", "/v1/tools")
      expect(response.status).toBe(200)
      expect(response.body["tools"]).toEqual([
        {
          alias: "user_sebastian_gmail_work",
          tool: "sendEmail",
          connection: { owner: "user", subject: "sebastian", integration: "gmail", name: "work" },
          decision: "allow"
        }
      ])
    }).pipe(Effect.provide(testServices)))

  it.effect("filters the caller's tools by integration and connection", () =>
    Effect.gen(function*() {
      const { call, store, accessProfile, approvalPolicy } = yield* setup()
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
      yield* store.replaceAccessProfileTools(
        accessProfile.id,
        routes.map(({ connection, tool }) => ({ connection, tool }))
      )
      yield* store.replaceApprovalPolicyTools(approvalPolicy.id, routes)

      const gmail = yield* call("GET", "/v1/tools?integration=gmail")
      expect(Schema.decodeUnknownSync(JsonRows)(gmail.body["tools"])
        .map((tool) => tool["tool"])).toEqual(["readEmail", "sendEmail"])

      const work = yield* call("GET", "/v1/tools?integration=gmail&connection=work")
      expect(work.body["tools"]).toMatchObject([{
        tool: "sendEmail",
        connection: { integration: "gmail", name: "work" }
      }])
    }).pipe(Effect.provide(testServices)))

  it.effect("executes an effective tool against the address built from the access profile", () =>
    Effect.gen(function*() {
      const { call, calls } = yield* setup()

      const response = yield* call("POST", "/v1/execute", {
        body: { alias: "user_sebastian_gmail_work", tool: "sendEmail", arguments: { to: "a@b.c" } }
      })

      expect(response.status).toBe(200)
      expect(response.body["status"]).toBe("succeeded")
      expect(calls).toHaveLength(1)
      expect(calls[0]?.address).toBe("tools.gmail.user.work.sendEmail")
    }).pipe(Effect.provide(testServices)))

  it.effect("refuses an unauthorized tool without calling the vendor", () =>
    Effect.gen(function*() {
      const { call, calls } = yield* setup()

      const response = yield* call("POST", "/v1/execute", {
        body: { alias: "user_sebastian_gmail_work", tool: "deleteEverything" }
      })

      expect(response.status).toBe(403)
      expect(calls).toHaveLength(0)
    }).pipe(Effect.provide(testServices)))

  it.effect("freezes a require_approval call instead of performing it", () =>
    Effect.gen(function*() {
      const { call, calls } = yield* setup({ decision: "require_approval" })

      const response = yield* call("POST", "/v1/execute", {
        body: { alias: "user_sebastian_gmail_work", tool: "sendEmail", arguments: { to: "a@b.c" } }
      })

      expect(response.status).toBe(200)
      expect(response.body["status"]).toBe("pending")
      expect(isApprovalId(response.body["approvalId"])).toBe(true)
      expect(calls).toHaveLength(0)
    }).pipe(Effect.provide(testServices)))

  it.effect("reports a vendor failure as 502 rather than a denial", () =>
    Effect.gen(function*() {
      const { call } = yield* setup({ fail: true })

      const response = yield* call("POST", "/v1/execute", {
        body: { alias: "user_sebastian_gmail_work", tool: "sendEmail" }
      })

      expect(response.status).toBe(502)
      expect(response.body["status"]).toBe("failed")
    }).pipe(Effect.provide(testServices)))

  it.effect("rejects a malformed body at the boundary", () =>
    Effect.gen(function*() {
      const { call } = yield* setup()
      const response = yield* call("POST", "/v1/execute", { body: { alias: "user_sebastian_gmail_work" } })
      expect(response.status).toBe(400)
    }).pipe(Effect.provide(testServices)))

  it.effect("provisioning does not imply gateway administration", () =>
    Effect.gen(function*() {
      const { call } = yield* setup({ capabilities: ["provision_connections"] })

      for (const [method, route] of [
        ["GET", "/v1/integrations"],
        ["POST", "/v1/integrations/discover"],
        ["GET", "/v1/connections"]
      ] as const) {
        const response = yield* call(method, route, { body: {} })
        expect(`${route} -> ${response.status}`).not.toBe(`${route} -> 403`)
      }

      for (const [method, route] of [
        ["GET", "/v1/clients"],
        ["POST", "/v1/clients"],
        ["GET", "/v1/access-profiles"],
        ["POST", "/v1/access-profiles"],
        ["GET", "/v1/approval-policies"],
        ["POST", "/v1/approval-policies"],
        ["GET", "/v1/approvals"],
        ["GET", "/v1/audit"]
      ] as const) {
        const response = yield* call(method, route, { body: {} })
        expect(`${route} -> ${response.status}`).toBe(`${route} -> 403`)
      }
    }).pipe(Effect.provide(testServices)))

  it.effect("permits administrative routes to a key with the administration capability", () =>
    Effect.gen(function*() {
      const { call } = yield* setup({ capabilities: ["provision_connections", "administer_gateway"] })
      expect((yield* call("GET", "/v1/integrations")).status).toBe(200)
      expect((yield* call("GET", "/v1/clients")).status).toBe(200)
      expect((yield* call("GET", "/v1/audit")).status).toBe(200)
    }).pipe(Effect.provide(testServices)))

  it.effect("summarizes dashboard readiness without per-client requests", () =>
    Effect.gen(function*() {
      const { call } = yield* setup({
        capabilities: ["provision_connections", "administer_gateway"]
      })
      const response = yield* call("GET", "/v1/overview")
      expect(response.status).toBe(200)
      expect(response.body).toEqual({
        connections: 0,
        clients: 1,
        accessProfiles: 2,
        accessProfileTools: 1,
        approvalPolicies: 2,
        approvalPolicyTools: 1,
        keys: 1,
        pendingApprovals: 0,
        recentActivity: []
      })
    }).pipe(Effect.provide(testServices)))

  it.effect("does not let one client read another's frozen call", () =>
    Effect.gen(function*() {
      const { call, store, client, accessProfile, approvalPolicy } = yield* setup({ decision: "require_approval" })
      const frozen = yield* call("POST", "/v1/execute", {
        body: { alias: "user_sebastian_gmail_work", tool: "sendEmail" }
      })
      const approvalId = String(frozen.body["approvalId"])

      const other = yield* store.createClient({
        id: (yield* newClientId),
        tenantId: defaultTenantId,
        accessProfileId: accessProfile.id,
        approvalPolicyId: approvalPolicy.id,
        name: "someone-else",
        capabilities: ["provision_connections"]
      })
      const otherKey = (yield* generateApiKey)
      yield* store.addApiKey({ id: otherKey.id, clientId: other.id, hash: otherKey.hash })

      expect((yield* call("GET", `/v1/approvals/${approvalId}`)).status).toBe(200)
      const peek = yield* call("GET", `/v1/approvals/${approvalId}`, { secret: otherKey.secret })
      expect(peek.status).toBe(404)
      expect(client.id).not.toBe(other.id)
    }).pipe(Effect.provide(testServices)))

  it.effect("issues a key exactly once and never returns it again", () =>
    Effect.gen(function*() {
      const { call, store } = yield* setup({ capabilities: ["provision_connections", "administer_gateway"] })
      const clientResponse = yield* call("POST", "/v1/clients", { body: { name: "sandbox" } })
      expect(clientResponse.status).toBe(201)
      const clientId = ClientId.make(String(clientResponse.body["id"]))

      const keyResponse = yield* call("POST", `/v1/clients/${clientId}/keys`, { body: {} })
      expect(keyResponse.status).toBe(201)
      const secret = String(keyResponse.body["secret"])
      expect(secret).toMatch(/^wfi_/)

      const stored = yield* store.listApiKeys(clientId)
      expect(JSON.stringify(stored)).not.toContain(secret)
    }).pipe(Effect.provide(testServices)))

  it.effect("manages reusable approval destinations and client assignments", () =>
    Effect.gen(function*() {
      const { call } = yield* setup({ capabilities: ["provision_connections", "administer_gateway"] })
      const createdClient = yield* call("POST", "/v1/clients", { body: { name: "notified" } })
      const clientId = String(createdClient.body["id"])
      const created = yield* call("POST", "/v1/approval-destinations", {
        body: { name: "phone", url: "https://notify.example/approvals" }
      })
      expect(created.status).toBe(201)
      expect(String(created.body["signingSecret"])).toMatch(/^wfs_/)
      const destination = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(created.body["destination"])
      const destinationId = destination.id
      const assigned = yield* call("POST", `/v1/clients/${clientId}/approval-destinations`, {
        body: { destinationIds: [destinationId] }
      })
      expect(assigned.body["destinationIds"]).toEqual([destinationId])
      const listed = yield* call("GET", "/v1/approval-destinations")
      expect(listed.body["destinations"]).toHaveLength(1)
    }).pipe(Effect.provide(testServices)))

  it.effect("uses a tool's conservative decision when seeding the default policy", () =>
    Effect.gen(function*() {
      const { call } = yield* setup({
        capabilities: ["provision_connections", "administer_gateway"],
        connections: [{ integration: "gmail", name: "work" }],
        tools: [{
          address: "tools.gmail.org.work.sendEmail",
          name: "sendEmail",
          owner: "org",
          defaultDecision: "require_approval"
        }]
      })
      const created = yield* call("POST", "/v1/clients", { body: { name: "sandbox" } })
      const clientId = String(created.body["id"])
      const response = yield* call("GET", `/v1/clients/${clientId}/tools`)
      expect(response.status).toBe(200)
      expect(JSON.stringify(response.body)).toContain("require_approval")
    }).pipe(Effect.provide(testServices)))

  it.effect("returns an authenticated dashboard link with a pending invocation", () =>
    Effect.gen(function*() {
      const { call } = yield* setup({
        decision: "require_approval",
        dashboardUrl: "https://gateway.example"
      })
      const response = yield* call("POST", "/v1/execute", {
        body: { alias: "user_sebastian_gmail_work", tool: "sendEmail" }
      })
      expect(response.body["approvalUrl"]).toBe(
        `https://gateway.example/approvals?approval=${String(response.body["approvalId"])}`
      )
    }).pipe(Effect.provide(testServices)))

  it.effect("revoking a client through the API cancels its frozen calls", () =>
    Effect.gen(function*() {
      const { call, client } = yield* setup({ decision: "require_approval", capabilities: ["provision_connections", "administer_gateway"] })
      yield* call("POST", "/v1/execute", { body: { alias: "user_sebastian_gmail_work", tool: "sendEmail" } })

      const response = yield* call("POST", `/v1/clients/${client.id}/revoke`, { body: {} })

      expect(response.status).toBe(200)
      expect(response.body["cancelledApprovals"]).toBe(1)
    }).pipe(Effect.provide(testServices)))
})

describe("gateway approval settlement", () => {
  it.effect("simultaneous retries freeze one invocation and record one approval event", () =>
    Effect.gen(function*() {
      const { call, store } = yield* setup({ decision: "require_approval" })
      const body = { alias: aliasForConnection(connection), tool: "sendEmail", arguments: { to: "a@b.c" } }
      const responses = yield* Effect.all(
        Array.from({ length: 8 }, () => call("POST", "/v1/execute", { body })),
        { concurrency: "unbounded" }
      )
      expect(responses.every((response) => response.status === 200)).toBe(true)
      expect(new Set(responses.map((response) => response.body["approvalId"])).size).toBe(1)
      expect(yield* store.listApprovals(defaultTenantId)).toHaveLength(1)
    }).pipe(Effect.provide(testServices)))

  it.effect("shared profiles cannot share or collect another client's approval", () =>
    Effect.gen(function*() {
      const { call, store, accessProfile, approvalPolicy } = yield* setup({ decision: "require_approval" })
      const other = yield* store.createClient({
        id: (yield* newClientId), tenantId: defaultTenantId, accessProfileId: accessProfile.id,
        approvalPolicyId: approvalPolicy.id, name: "other-agent", capabilities: []
      })
      const key = (yield* generateApiKey)
      yield* store.addApiKey({ id: key.id, clientId: other.id, hash: key.hash })
      const body = { alias: aliasForConnection(connection), tool: "sendEmail", arguments: { to: "a@b.c" } }
      const first = yield* call("POST", "/v1/execute", { body })
      const second = yield* call("POST", "/v1/execute", { body, secret: key.secret })
      expect(second.body["approvalId"]).not.toBe(first.body["approvalId"])
      yield* call("POST", `/v1/approvals/${String(first.body["approvalId"])}/approve`, { body: {}, local: true })
      const retry = yield* call("POST", "/v1/execute", { body, secret: key.secret })
      expect(retry.body["status"]).toBe("pending")
      expect(retry.body["approvalId"]).toBe(second.body["approvalId"])
      expect((yield* call("POST", "/v1/execute", { body })).body["status"]).toBe("succeeded")
    }).pipe(Effect.provide(testServices)))

  it.effect("the same tool and arguments on different accounts keep distinct approvals and targets", () =>
    Effect.gen(function*() {
      const { call, store, accessProfile, approvalPolicy, calls } = yield* setup({ decision: "require_approval" })
      const personal = { ...connection, name: ConnectionName.make("personal") }
      const tools = [connection, personal].map((connection) => ({ connection, tool: ToolName.make("sendEmail") }))
      yield* store.replaceAccessProfileTools(accessProfile.id, tools)
      yield* (store.replaceApprovalPolicyTools(approvalPolicy.id, tools.map((tool) => ({ ...tool, decision: "require_approval" }))))
      const first = yield* call("POST", "/v1/execute", { body: { alias: aliasForConnection(connection), tool: "sendEmail", arguments: { to: "a@b.c" } } })
      const second = yield* call("POST", "/v1/execute", { body: { alias: aliasForConnection(personal), tool: "sendEmail", arguments: { to: "a@b.c" } } })
      expect(second.body["approvalId"]).not.toBe(first.body["approvalId"])
      const response = yield* call("POST", `/v1/approvals/${String(second.body["approvalId"])}/approve`, { body: {}, local: true })
      expect(response.status).toBe(200)
      expect(calls).toEqual([{ address: "tools.gmail.user.personal.sendEmail", input: { to: "a@b.c" } }])
    }).pipe(Effect.provide(testServices)))

  it.effect("concurrent decisions cannot execute twice, deny an executing call, or collect it early", () =>
    Effect.gen(function*() {
      const started = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const { call, calls, store } = yield* setup({
        decision: "require_approval",
        beforeExecute: () => {
          started.resolve()
          return release.promise
        }
      })
      const body = { alias: aliasForConnection(connection), tool: "sendEmail" }
      const frozen = yield* call("POST", "/v1/execute", { body })
      const id = String(frozen.body["approvalId"])

      const approving = yield* Effect.forkChild(
        call("POST", `/v1/approvals/${id}/approve`, { body: {}, local: true })
      )
      yield* Effect.promise(() => started.promise)
      const [approve, deny, retry] = yield* Effect.all([
        call("POST", `/v1/approvals/${id}/approve`, { body: {}, local: true }),
        call("POST", `/v1/approvals/${id}/deny`, { body: {}, local: true }),
        call("POST", "/v1/execute", { body })
      ], { concurrency: "unbounded" })

      expect(approve.status).toBe(400)
      expect(deny.status).toBe(400)
      expect(retry.body["approvalId"]).toBe(id)
      expect(retry.body["status"]).toBe("pending")
      // A cutoff well past the freeze: an executing call is not pending, so
      // maintenance leaves it alone rather than expiring it mid-flight.
      const wellPast = new Date((yield* Clock.currentTimeMillis) + 86_400_000)
      expect(yield* store.expireApprovals(wellPast)).toBe(0)
      expect(calls).toHaveLength(1)

      release.resolve()
      yield* Fiber.join(approving)
      expect((yield* call("POST", "/v1/execute", { body })).body["status"]).toBe("succeeded")
      expect(calls).toHaveLength(1)
    }).pipe(Effect.provide(testServices)))

  it.effect("a durable execution claim survives reopening the store and cannot be replayed", () =>
    Effect.gen(function*() {
      const { call, store, calls } = yield* setup({ decision: "require_approval" })
      const body = { alias: aliasForConnection(connection), tool: "sendEmail" }
      const frozen = yield* call("POST", "/v1/execute", { body })
      const approval = (yield* store.listApprovals(defaultTenantId))[0]
      if (approval === undefined) throw new Error("Missing approval")
      yield* store.claimApproval({ tenantId: defaultTenantId, id: approval.id, decidedBy: "human" })
      const reopened = yield* Effect.acquireRelease(
        createGatewayStore(store.databasePath),
        (reopened) => Effect.orDie(reopened.close())
      )
      expect((yield* reopened.getApproval(defaultTenantId, approval.id))?.status).toBe("executing")
      expect(yield* reopened.claimApproval({
        tenantId: defaultTenantId, id: approval.id, decidedBy: "human"
      })).toBe(false)
      expect(yield* reopened.collectApproval(defaultTenantId, approval.id)).toBe(false)
      expect((yield* call("POST", `/v1/approvals/${String(frozen.body["approvalId"])}/approve`, { body: {}, local: true })).status).toBe(400)
      expect((yield* call("POST", "/v1/execute", { body })).body["approvalId"]).toBe(approval.id)
      expect(calls).toHaveLength(0)
    }).pipe(Effect.provide(testServices)))

  it.effect("an administrative API key cannot make a human approval decision", () =>
    Effect.gen(function*() {
      const { call, calls } = yield* setup({
        decision: "require_approval",
        capabilities: ["provision_connections", "administer_gateway"]
      })
      const frozen = yield* call("POST", "/v1/execute", {
        body: { alias: "user_sebastian_gmail_work", tool: "sendEmail" }
      })
      const approvalId = String(frozen.body["approvalId"])

      const approved = yield* call("POST", `/v1/approvals/${approvalId}/approve`, {
        body: { decidedBy: "api-key" }
      })
      const denied = yield* call("POST", `/v1/approvals/${approvalId}/deny`, {
        body: { decidedBy: "api-key" }
      })

      expect(approved.status).toBe(403)
      expect(denied.status).toBe(403)
      expect(calls).toHaveLength(0)
    }).pipe(Effect.provide(testServices)))

  it.effect("the gateway performs the call itself once approved", () =>
    Effect.gen(function*() {
      const { call, calls } = yield* setup({ decision: "require_approval", capabilities: ["provision_connections", "administer_gateway"] })
      const frozen = yield* call("POST", "/v1/execute", {
        body: { alias: "user_sebastian_gmail_work", tool: "sendEmail", arguments: { to: "a@b.c" } }
      })
      const approvalId = String(frozen.body["approvalId"])
      expect(calls).toHaveLength(0)

      const approved = yield* call("POST", `/v1/approvals/${approvalId}/approve`, {
        body: { decidedBy: "sebastian" },
        local: true
      })

      expect(approved.status).toBe(200)
      expect(calls).toHaveLength(1)
      expect(calls[0]?.input).toEqual({ to: "a@b.c" })
    }).pipe(Effect.provide(testServices)))

  it.effect("refuses to approve twice", () =>
    Effect.gen(function*() {
      const { call } = yield* setup({ decision: "require_approval", capabilities: ["provision_connections", "administer_gateway"] })
      const frozen = yield* call("POST", "/v1/execute", {
        body: { alias: "user_sebastian_gmail_work", tool: "sendEmail" }
      })
      const approvalId = String(frozen.body["approvalId"])

      expect((yield* call(
        "POST",
        `/v1/approvals/${approvalId}/approve`,
        { body: {}, local: true }
      )).status).toBe(200)
      expect((yield* call(
        "POST",
        `/v1/approvals/${approvalId}/approve`,
        { body: {}, local: true }
      )).status).toBe(400)
    }).pipe(Effect.provide(testServices)))

  it.effect("re-checks authority at approval time, however it was taken away", () =>
    Effect.gen(function*() {
      const reassigned = yield* setup({
        decision: "require_approval",
        capabilities: ["provision_connections", "administer_gateway"]
      })
      const frozen = yield* reassigned.call("POST", "/v1/execute", {
        body: { alias: "user_sebastian_gmail_work", tool: "sendEmail" }
      })
      const emptyProfile = yield* reassigned.store.createAccessProfile({
        id: (yield* newAccessProfileId),
        tenantId: defaultTenantId,
        name: "No mail access"
      })
      yield* reassigned.store.assignAccessProfile(
        defaultTenantId,
        reassigned.client.id,
        emptyProfile.id
      )
      expect((yield* reassigned.call(
        "POST",
        `/v1/approvals/${String(frozen.body["approvalId"])}/approve`,
        { body: {}, local: true }
      )).status).toBe(400)
      expect(reassigned.calls).toHaveLength(0)

      const emptied = yield* setup({
        decision: "require_approval",
        capabilities: ["provision_connections", "administer_gateway"]
      })
      const stale = yield* emptied.call("POST", "/v1/execute", {
        body: { alias: "user_sebastian_gmail_work", tool: "sendEmail" }
      })
      yield* emptied.store.replaceAccessProfileTools(emptied.accessProfile.id, [])
      expect((yield* emptied.call(
        "POST",
        `/v1/approvals/${String(stale.body["approvalId"])}/approve`,
        { body: {}, local: true }
      )).status).toBe(400)
      expect(emptied.calls).toHaveLength(0)
    }).pipe(Effect.provide(testServices)))

  it.effect("denying settles without performing the call", () =>
    Effect.gen(function*() {
      const { call, calls } = yield* setup({ decision: "require_approval", capabilities: ["provision_connections", "administer_gateway"] })
      const frozen = yield* call("POST", "/v1/execute", {
        body: { alias: "user_sebastian_gmail_work", tool: "sendEmail" }
      })
      const approvalId = String(frozen.body["approvalId"])

      const denied = yield* call("POST", `/v1/approvals/${approvalId}/deny`, {
        body: { decidedBy: "sebastian" },
        local: true
      })

      expect(denied.status).toBe(200)
      expect(calls).toHaveLength(0)
    }).pipe(Effect.provide(testServices)))
})

describe("frozen calls and retries", () => {
  /** The one call these tests freeze, retry and collect. */
  const sendEmail = (args: Record<string, typeof Schema.Json.Type> = { to: "a@b.c" }) => ({
    body: { alias: "user_sebastian_gmail_work", tool: "sendEmail", arguments: args }
  })

  it.effect("different arguments are a different frozen call", () =>
    Effect.gen(function*() {
      const { call, store } = yield* setup({ decision: "require_approval", capabilities: ["provision_connections", "administer_gateway"] })

      const first = yield* call("POST", "/v1/execute", sendEmail({ to: "a@b.c" }))
      const second = yield* call("POST", "/v1/execute", sendEmail({ to: "someone-else@b.c" }))

      expect(second.body["approvalId"]).not.toBe(first.body["approvalId"])
      expect(yield* store.listApprovals(defaultTenantId, "pending")).toHaveLength(2)
    }).pipe(Effect.provide(testServices)))

  it.effect("the retry after approval collects the result exactly once", () =>
    Effect.gen(function*() {
      const { call, store, calls } = yield* setup({ decision: "require_approval", capabilities: ["provision_connections", "administer_gateway"] })
      const frozen = yield* call("POST", "/v1/execute", sendEmail())
      const approvalId = String(frozen.body["approvalId"])
      yield* call("POST", `/v1/approvals/${approvalId}/approve`, {
        body: {},
        local: true
      })
      expect(calls).toHaveLength(1)

      const collected = yield* call("POST", "/v1/execute", sendEmail())
      expect(collected.body["status"]).toBe("succeeded")
      expect(collected.body["result"]).toEqual({ ok: true })
      expect(calls).toHaveLength(1)

      const afterCollection = yield* call("POST", "/v1/execute", sendEmail())
      expect(afterCollection.body["status"]).toBe("pending")
      expect(afterCollection.body["approvalId"]).not.toBe(approvalId)
      expect(yield* store.listApprovals(defaultTenantId, "pending")).toHaveLength(1)
    }).pipe(Effect.provide(testServices)))

  it.effect("a denial is delivered to the caller rather than left pending forever", () =>
    Effect.gen(function*() {
      const { call } = yield* setup({ decision: "require_approval", capabilities: ["provision_connections", "administer_gateway"] })
      const frozen = yield* call("POST", "/v1/execute", sendEmail())
      const approvalId = String(frozen.body["approvalId"])
      yield* call("POST", `/v1/approvals/${approvalId}/deny`, {
        body: { decidedBy: "sebastian" },
        local: true
      })

      const collected = yield* call("POST", "/v1/execute", sendEmail())

      expect(collected.status).toBe(403)
      expect(collected.body["status"]).toBe("denied")
      expect(String(collected.body["reason"])).toContain("local:support-agent")
      expect(String(collected.body["reason"])).not.toContain("sebastian")
    }).pipe(Effect.provide(testServices)))

  it.effect("the caller can read its own frozen call without an administrative key", () =>
    Effect.gen(function*() {
      const { call } = yield* setup({ decision: "require_approval" })
      const frozen = yield* call("POST", "/v1/execute", sendEmail())

      const polled = yield* call("GET", `/v1/approvals/${String(frozen.body["approvalId"])}`)

      expect(polled.status).toBe(200)
      expect(polled.body["status"]).toBe("pending")
      expect(polled.body["collectedAt"]).toBeNull()
    }).pipe(Effect.provide(testServices)))
})

describe("provisioning surface", () => {
  it.effect("validates the node shape a workflow actually authors", () =>
    Effect.gen(function*() {
      const { call } = yield* setup({
        capabilities: ["provision_connections", "administer_gateway"],
        tools: [{ address: "tools.gmail.user.work.sendEmail", name: "sendEmail" }]
      })

      const report = yield* call("POST", "/v1/validate", {
        body: { node: { source: { kind: "gateway", alias: "user_sebastian_gmail_work", tool: "sendEmail" } } }
      })

      expect(report.status).toBe(200)
      expect(report.body["ok"]).toBe(true)
      const checks = Schema.decodeUnknownSync(
        Schema.Array(Schema.Struct({ check: Schema.String }))
      )(report.body["findings"]).map((finding) => finding.check)
      expect(checks).toEqual(["structural", "authorization", "catalog"])
    }).pipe(Effect.provide(testServices)))

  it.effect("reports an alias this key does not hold", () =>
    Effect.gen(function*() {
      const { call } = yield* setup({ capabilities: ["provision_connections", "administer_gateway"] })

      const report = yield* call("POST", "/v1/validate", {
        body: { node: { source: { kind: "gateway", alias: "user_sebastian_gmail_work", tool: "deleteEverything" } } }
      })

      expect(report.body["ok"]).toBe(false)
      expect(JSON.stringify(report.body)).toContain("not authorized")
    }).pipe(Effect.provide(testServices)))

  it.effect("removes a connection by the name it was asked for, not the stored one", () =>
    Effect.gen(function*() {
      const { call, removed } = yield* setup({
        capabilities: ["provision_connections", "administer_gateway"],
        connections: [{ integration: "gmail", name: "docs_demo" }]
      })

      const response = yield* call("DELETE", "/v1/connections/gmail/docs-demo")

      expect(response.status).toBe(200)
      expect(response.body["connection"]).toBe("docs_demo")
      expect(removed).toEqual([{ integration: "gmail", name: "docs_demo" }])
    }).pipe(Effect.provide(testServices)))

  it.effect("removing an integration takes its connections and their policy rules", () =>
    Effect.gen(function*() {
      const { call, store, accessProfile, approvalPolicy, forgotten } = yield* setup({
        capabilities: ["provision_connections", "administer_gateway"],
        connections: [{ integration: "gmail", name: "work" }]
      })

      expect(yield* store.listAccessProfileTools(accessProfile.id)).toHaveLength(1)
      expect(yield* store.listApprovalPolicyTools(approvalPolicy.id)).toHaveLength(1)

      const response = yield* call("DELETE", "/v1/integrations/gmail")

      expect(response.status).toBe(200)
      expect(forgotten).toEqual(["gmail"])
      expect(response.body["connections"]).toEqual(["work"])
      expect(yield* store.listAccessProfileTools(accessProfile.id)).toEqual([])
      expect(yield* store.listApprovalPolicyTools(approvalPolicy.id)).toEqual([])
    }).pipe(Effect.provide(testServices)))

  it.effect("renames an integration without moving its slug", () =>
    Effect.gen(function*() {
      const { call, renamed } = yield* setup({
        capabilities: ["provision_connections", "administer_gateway"],
        connections: [{ integration: "statelessserver", name: "default" }]
      })

      const response = yield* call("POST", "/v1/integrations/statelessserver/name", {
        body: { name: "Gmail" }
      })

      expect(response.status).toBe(200)
      expect(response.body["name"]).toBe("Gmail")
      expect(response.body["slug"]).toBe("statelessserver")
      expect(renamed).toEqual([{ slug: "statelessserver", name: "Gmail" }])
    }).pipe(Effect.provide(testServices)))

  it.effect("refuses to rename or remove an integration it never installed", () =>
    Effect.gen(function*() {
      const { call, renamed, forgotten } = yield* setup({
        capabilities: ["provision_connections", "administer_gateway"],
        connections: [{ integration: "gmail", name: "work" }]
      })

      expect((yield* call("POST", "/v1/integrations/notion/name", {
        body: { name: "Notion" }
      })).status).toBe(404)
      expect((yield* call("DELETE", "/v1/integrations/notion")).status).toBe(404)
      expect(renamed).toEqual([])
      expect(forgotten).toEqual([])
    }).pipe(Effect.provide(testServices)))

  it.effect("says which connections exist when none matches", () =>
    Effect.gen(function*() {
      const { call } = yield* setup({
        capabilities: ["provision_connections", "administer_gateway"],
        connections: [{ integration: "gmail", name: "work" }]
      })

      const response = yield* call("DELETE", "/v1/connections/gmail/personal")

      expect(response.status).toBe(404)
      expect(String(response.body["error"])).toContain("work")
    }).pipe(Effect.provide(testServices)))

  it.effect("lists a client's keys without their hashes, and revokes one", () =>
    Effect.gen(function*() {
      const { call, client, key, store } = yield* setup({ capabilities: ["provision_connections", "administer_gateway"] })

      const listed = yield* call("GET", `/v1/clients/${client.id}/keys`)
      const keys = Schema.decodeUnknownSync(Schema.Array(JsonBody))(listed.body["keys"])
      expect(keys).toHaveLength(1)
      expect(keys[0]?.["id"]).toBe(key.id)
      expect(JSON.stringify(keys)).not.toContain(key.hash)

      const revoked = yield* call("POST", `/v1/keys/${key.id}/revoke`)
      expect(revoked.status).toBe(200)
      const after = yield* store.listApiKeys(client.id)
      expect(after[0]?.revokedAt).not.toBeNull()
    }).pipe(Effect.provide(testServices)))

  it.effect("names the MCP endpoint alongside the clients, and omits it without a public origin", () =>
    Effect.gen(function*() {
      const named = yield* setup({
        capabilities: ["provision_connections", "administer_gateway"],
        mcpUrl: "https://gateway.example/mcp"
      })
      expect((yield* named.call("GET", "/v1/clients")).body["mcpUrl"])
        .toBe("https://gateway.example/mcp")

      const anonymous = yield* setup({
        capabilities: ["provision_connections", "administer_gateway"]
      })
      expect((yield* anonymous.call("GET", "/v1/clients")).body["mcpUrl"]).toBeUndefined()
    }).pipe(Effect.provide(testServices)))

  it.effect("filters and windows the audit trail, and says how much there is", () =>
    Effect.gen(function*() {
      const { call } = yield* setup({ capabilities: ["provision_connections", "administer_gateway"] })
      yield* call("POST", "/v1/execute", { body: { alias: "user_sebastian_gmail_work", tool: "sendEmail" } })
      yield* call("POST", "/v1/execute", { body: { alias: "user_sebastian_gmail_work", tool: "nope" } })

      const all = yield* call("GET", "/v1/audit")
      expect(all.body["total"]).toBe(2)

      const denied = yield* call("GET", "/v1/audit?outcome=denied")
      expect(denied.body["total"]).toBe(1)
      expect(Schema.decodeUnknownSync(Schema.Array(Schema.Json))(denied.body["records"])).toHaveLength(1)

      const windowed = yield* call("GET", "/v1/audit?limit=1&offset=1")
      expect(windowed.body["total"]).toBe(2)
      expect(windowed.body["offset"]).toBe(1)
      expect(Schema.decodeUnknownSync(Schema.Array(Schema.Json))(windowed.body["records"])).toHaveLength(1)
    }).pipe(Effect.provide(testServices)))

  it.effect("refuses a window it cannot read rather than quietly serving another one", () =>
    Effect.gen(function*() {
      const { call } = yield* setup({ capabilities: ["provision_connections", "administer_gateway"] })
      for (const query of ["limit=abc", "limit=0", "limit=1.5", "offset=-1", "since=nope"]) {
        expect((yield* call("GET", `/v1/audit?${query}`)).status).toBe(400)
      }
    }).pipe(Effect.provide(testServices)))
})
