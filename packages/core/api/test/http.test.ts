import { FetchHttpClient } from "effect/unstable/http"
import { stubIntegrationsContext } from "./stubs.ts"
import { InvocationError } from "@integrations/integrations"
import { run, runAll } from "./effect.ts"
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect, Option, Schema } from "effect"
import { ToolAddress, whenPresent } from "@integrations/contracts"
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import type { Connection, Tool } from "@integrations/contracts"
import {
  aliasForConnection,
  ClientId,
  ConnectionName,
  createGatewayHandler,
  createGatewayStore,
  defaultTenantId,
  generateApiKey,
  IntegrationSlug,
  newClientId,
  newAccessProfileId,
  newApprovalPolicyId,
  SubjectId,
  ToolName
} from "./gateway.ts"
import type { ConnectionRef, GatewayStore } from "./gateway.ts"

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

const setup = async (options: {
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
} = {}) => {
  const directory = await run(mkdtemp(path.join(tmpdir(), "wf-gateway-http-")))
  directories.push(directory)
  const store = await run(createGatewayStore(path.join(directory, "gateway.sqlite")))
  stores.push(store)

  const accessProfile = await run(store.createAccessProfile({
    id: (await run(newAccessProfileId)), tenantId: defaultTenantId, name: `access-${crypto.randomUUID()}`
  }))
  await run(store.replaceAccessProfileTools(accessProfile.id, [{
      connection,
      tool: ToolName.make("sendEmail")
    }]))
  const approvalPolicy = await run(store.createApprovalPolicy({
    id: (await run(newApprovalPolicyId)), tenantId: defaultTenantId, name: `approval-${crypto.randomUUID()}`
  }))
  await run(store.replaceApprovalPolicyTools(approvalPolicy.id, [{
      connection,
      tool: ToolName.make("sendEmail"),
      decision: options.decision ?? "allow"
    }]))
  const client = await run(store.createClient({
    id: (await run(newClientId)),
    tenantId: defaultTenantId,
    accessProfileId: accessProfile.id,
    approvalPolicyId: approvalPolicy.id,
    name: "support-agent",
    capabilities: options.capabilities ?? ["provision_connections"]
  }))
  const key = (await run(generateApiKey))
  await run(store.addApiKey({ id: key.id, clientId: client.id, hash: key.hash }))
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

  const call = async (
    method: string,
    pathname: string,
    init: {
      readonly body?: typeof Schema.Json.Type
      readonly secret?: string | null
      readonly local?: boolean
    } = {}
  ) => {
    const secret = init.local === true
      ? null
      : init.secret === undefined
        ? key.secret
        : init.secret
    const headers = secret === null
      ? { "content-type": "application/json" }
      : { "content-type": "application/json", authorization: `Bearer ${secret}` }
    const response = await run(handle(
      new Request(`http://gateway.test${pathname}`, {
        method,
        headers,
        ...whenPresent("body", JSON.stringify(init.body))
      }),
      init.local === true ? { localSecret: key.secret } : undefined
    ))
    return {
      status: response.status,
      body: Schema.decodeUnknownSync(JsonBody)(await run(response.json()))
    }
  }

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
}

describe("gateway http surface", () => {
  test("onboarding creates only the selected tools with separate configurations and no administrative power", async () => {
    const { call, store, accessProfile } = await setup({
      tools: [{ address: "tools.gmail.org.work.sendEmail", name: "sendEmail", owner: "org" }]
    })
    const selected = { connection: { owner: "org", integration: "gmail", name: "work" }, tool: "sendEmail", decision: "require_approval" }
    const response = await call("POST", "/v1/clients/configured", { local: true, body: { name: "New assistant", tools: [selected] } })
    expect(response.status).toBe(201)
    expect(response.body["capabilities"]).toEqual([])
    expect(response.body["accessProfileId"]).not.toBe(accessProfile.id)
    const id = String(response.body["id"])
    const tools = await call("GET", `/v1/clients/${id}/tools`, { local: true })
    expect(tools.body["tools"]).toMatchObject([{ alias: "org_gmail_work", tool: "sendEmail", decision: "require_approval" }])
    expect(await run(store.listAccessProfileTools(accessProfile.id))).toHaveLength(1)
    expect((await call("POST", "/v1/clients/configured", { local: true, body: { name: "New assistant", tools: [selected] } })).status).toBe(400)
    expect((await call("POST", "/v1/clients/configured", { local: true, body: { name: "Unavailable", tools: [{ ...selected, tool: "missing" }] } })).status).toBe(400)
    expect(await run(store.findClientByName(defaultTenantId, "Unavailable"))).toBeUndefined()
  })

  test("serves each API key's effective tools over MCP", async () => {
    const { handle, key, calls } = await run(setup())
    const client = new Client({ name: "gateway-test", version: "1.0.0" })
    const transport = new StreamableHTTPClientTransport(
      new URL("http://gateway.test/mcp"),
      {
        authProvider: { token: async () => key.secret },
        fetch: (input, init) => handle(new Request(input, init))
      }
    )

    try {
      await run(client.connect(transport))
      const listed = await run(client.listTools())
      expect(listed.tools).toEqual([expect.objectContaining({
        name: "user_sebastian_gmail_work__sendEmail",
        description: "Send an email",
        inputSchema: expect.objectContaining({ type: "object" })
      })])

      const called = await run(client.callTool({
        name: "user_sebastian_gmail_work__sendEmail",
        arguments: { to: "a@b.c" }
      }))
      expect(called.isError).not.toBe(true)
      expect(calls).toEqual([{
        address: "tools.gmail.user.work.sendEmail",
        input: { to: "a@b.c" }
      }])
    } finally {
      await run(client.close())
    }
  })

  test("requires an API key on the MCP endpoint", async () => {
    const { handle } = await run(setup())
    const response = await run(handle(new Request("http://gateway.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    })))
    expect(response.status).toBe(401)
    expect(response.headers.get("www-authenticate")).toBe("Bearer")
  })

  test("serves health without a key", async () => {
    const { call } = await run(setup())
    const response = await run(call("GET", "/v1/health", { secret: null }))
    expect(response.status).toBe(200)
  })

  test("requires a key on every other route", async () => {
    const { call } = await run(setup())
    expect((await run(call("GET", "/v1/tools", { secret: null }))).status).toBe(401)
  })

  test("rejects an unknown key with 401 and a revoked client with 403", async () => {
    const { call, client, store } = await run(setup())
    expect((await run(call("GET", "/v1/tools", { secret: "wfi_nope" }))).status).toBe(401)

    await run(store.revokeClient(defaultTenantId, client.id))
    expect((await run(call("GET", "/v1/tools"))).status).toBe(403)
  })

  test("distinguishes an unknown path from a wrong method", async () => {
    const { call } = await run(setup())
    expect((await run(call("GET", "/v1/nothing"))).status).toBe(404)
    expect((await run(call("DELETE", "/v1/tools"))).status).toBe(405)
  })

  test("lists only the caller's effective tools", async () => {
    const { call } = await run(setup())
    const response = await run(call("GET", "/v1/tools"))
    expect(response.status).toBe(200)
    expect(response.body["tools"]).toEqual([
      {
        alias: "user_sebastian_gmail_work",
        tool: "sendEmail",
        connection: { owner: "user", subject: "sebastian", integration: "gmail", name: "work" },
        decision: "allow"
      }
    ])
  })

  test("executes an effective tool against the address built from the access profile", async () => {
    const { call, calls } = await run(setup())

    const response = await run(call("POST", "/v1/execute", {
      body: { alias: "user_sebastian_gmail_work", tool: "sendEmail", arguments: { to: "a@b.c" } }
    }))

    expect(response.status).toBe(200)
    expect(response.body["status"]).toBe("succeeded")
    expect(calls).toHaveLength(1)
    expect(calls[0]?.address).toBe("tools.gmail.user.work.sendEmail")
  })

  test("refuses an unauthorized tool without calling the vendor", async () => {
    const { call, calls } = await run(setup())

    const response = await run(call("POST", "/v1/execute", {
      body: { alias: "user_sebastian_gmail_work", tool: "deleteEverything" }
    }))

    expect(response.status).toBe(403)
    expect(calls).toHaveLength(0)
  })

  test("freezes a require_approval call instead of performing it", async () => {
    const { call, calls } = await run(setup({ decision: "require_approval" }))

    const response = await run(call("POST", "/v1/execute", {
      body: { alias: "user_sebastian_gmail_work", tool: "sendEmail", arguments: { to: "a@b.c" } }
    }))

    expect(response.status).toBe(200)
    expect(response.body["status"]).toBe("pending")
    expect(response.body["approvalId"]).toBeString()
    expect(calls).toHaveLength(0)
  })

  test("reports a vendor failure as 502 rather than a denial", async () => {
    const { call } = await run(setup({ fail: true }))

    const response = await run(call("POST", "/v1/execute", {
      body: { alias: "user_sebastian_gmail_work", tool: "sendEmail" }
    }))

    expect(response.status).toBe(502)
    expect(response.body["status"]).toBe("failed")
  })

  test("rejects a malformed body at the boundary", async () => {
    const { call } = await run(setup())
    const response = await run(call("POST", "/v1/execute", { body: { alias: "user_sebastian_gmail_work" } }))
    expect(response.status).toBe(400)
  })

  test("provisioning does not imply gateway administration", async () => {
    const { call } = await run(setup({ capabilities: ["provision_connections"] }))

    for (const [method, route] of [
      ["GET", "/v1/integrations"],
      ["POST", "/v1/integrations/discover"],
      ["GET", "/v1/connections"]
    ] as const) {
      const response = await run(call(method, route, { body: {} }))
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
      const response = await run(call(method, route, { body: {} }))
      expect(`${route} -> ${response.status}`).toBe(`${route} -> 403`)
    }
  })

  test("permits administrative routes to a key with the administration capability", async () => {
    const { call } = await run(setup({ capabilities: ["provision_connections", "administer_gateway"] }))
    expect((await run(call("GET", "/v1/integrations"))).status).toBe(200)
    expect((await run(call("GET", "/v1/clients"))).status).toBe(200)
    expect((await run(call("GET", "/v1/audit"))).status).toBe(200)
  })

  test("summarizes dashboard readiness without per-client requests", async () => {
    const { call } = await run(setup({
      capabilities: ["provision_connections", "administer_gateway"]
    }))
    const response = await run(call("GET", "/v1/overview"))
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
  })

  test("does not let one client read another's frozen call", async () => {
    const { call, store, client, accessProfile, approvalPolicy } = await run(setup({ decision: "require_approval" }))
    const frozen = await run(call("POST", "/v1/execute", {
      body: { alias: "user_sebastian_gmail_work", tool: "sendEmail" }
    }))
    const approvalId = String(frozen.body["approvalId"])

    const other = await run(store.createClient({
      id: (await run(newClientId)),
      tenantId: defaultTenantId,
      accessProfileId: accessProfile.id,
      approvalPolicyId: approvalPolicy.id,
      name: "someone-else",
      capabilities: ["provision_connections"]
    }))
    const otherKey = (await run(generateApiKey))
    await run(store.addApiKey({ id: otherKey.id, clientId: other.id, hash: otherKey.hash }))

    expect((await run(call("GET", `/v1/approvals/${approvalId}`))).status).toBe(200)
    const peek = await run(call("GET", `/v1/approvals/${approvalId}`, { secret: otherKey.secret }))
    expect(peek.status).toBe(404)
    expect(client.id).not.toBe(other.id)
  })

  test("issues a key exactly once and never returns it again", async () => {
    const { call, store } = await run(setup({ capabilities: ["provision_connections", "administer_gateway"] }))
    const clientResponse = await run(call("POST", "/v1/clients", { body: { name: "sandbox" } }))
    expect(clientResponse.status).toBe(201)
    const clientId = ClientId.make(String(clientResponse.body["id"]))

    const keyResponse = await run(call("POST", `/v1/clients/${clientId}/keys`, { body: {} }))
    expect(keyResponse.status).toBe(201)
    const secret = String(keyResponse.body["secret"])
    expect(secret).toStartWith("wfi_")

    const stored = await run(store.listApiKeys(clientId))
    expect(JSON.stringify(stored)).not.toContain(secret)
  })

  test("a new client defaults to invocation-only authority", async () => {
    const { call } = await run(setup({ capabilities: ["provision_connections", "administer_gateway"] }))
    const response = await run(call("POST", "/v1/clients", { body: { name: "sandbox" } }))
    expect(response.body["capabilities"]).toEqual([])
  })

  test("updates client capabilities and approval delivery", async () => {
    const { call } = await run(setup({
      capabilities: ["provision_connections", "administer_gateway"]
    }))
    const created = await run(call("POST", "/v1/clients", { body: { name: "sandbox" } }))
    const clientId = String(created.body["id"])
    const response = await run(call("POST", `/v1/clients/${clientId}/settings`, {
      body: {
        capabilities: ["provision_connections"],
        approvalDelivery: { returnLink: false }
      }
    }))
    expect(response.status).toBe(200)
    expect(response.body["capabilities"]).toEqual(["provision_connections"])
    expect(response.body["approvalDelivery"]).toEqual({ returnLink: false })
  })

  test("manages reusable approval destinations and client assignments", async () => {
    const { call } = await run(setup({ capabilities: ["provision_connections", "administer_gateway"] }))
    const createdClient = await run(call("POST", "/v1/clients", { body: { name: "notified" } }))
    const clientId = String(createdClient.body["id"])
    const created = await run(call("POST", "/v1/approval-destinations", {
      body: { name: "phone", url: "https://notify.example/approvals" }
    }))
    expect(created.status).toBe(201)
    expect(String(created.body["signingSecret"])).toStartWith("wfs_")
    const destination = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(created.body["destination"])
    const destinationId = destination.id
    const assigned = await run(call("POST", `/v1/clients/${clientId}/approval-destinations`, {
      body: { destinationIds: [destinationId] }
    }))
    expect(assigned.body["destinationIds"]).toEqual([destinationId])
    const listed = await run(call("GET", "/v1/approval-destinations"))
    expect(listed.body["destinations"]).toHaveLength(1)
  })

  test("uses a tool's conservative decision when seeding the default policy", async () => {
    const { call } = await run(setup({
      capabilities: ["provision_connections", "administer_gateway"],
      connections: [{ integration: "gmail", name: "work" }],
      tools: [{
        address: "tools.gmail.org.work.sendEmail",
        name: "sendEmail",
        owner: "org",
        defaultDecision: "require_approval"
      }]
    }))
    const created = await run(call("POST", "/v1/clients", { body: { name: "sandbox" } }))
    const clientId = String(created.body["id"])
    const response = await run(call("GET", `/v1/clients/${clientId}/tools`))
    expect(response.status).toBe(200)
    expect(JSON.stringify(response.body)).toContain("require_approval")
  })

  test("returns an authenticated dashboard link with a pending invocation", async () => {
    const { call } = await run(setup({
      decision: "require_approval",
      dashboardUrl: "https://gateway.example"
    }))
    const response = await run(call("POST", "/v1/execute", {
      body: { alias: "user_sebastian_gmail_work", tool: "sendEmail" }
    }))
    expect(response.body["approvalUrl"]).toBe(
      `https://gateway.example/approvals?approval=${String(response.body["approvalId"])}`
    )
  })

  test("revoking a client through the API cancels its frozen calls", async () => {
    const { call, client } = await run(setup({ decision: "require_approval", capabilities: ["provision_connections", "administer_gateway"] }))
    await run(call("POST", "/v1/execute", { body: { alias: "user_sebastian_gmail_work", tool: "sendEmail" } }))

    const response = await run(call("POST", `/v1/clients/${client.id}/revoke`, { body: {} }))

    expect(response.status).toBe(200)
    expect(response.body["cancelledApprovals"]).toBe(1)
  })
})

describe("gateway approval settlement", () => {
  test("simultaneous retries freeze one invocation and record one approval event", async () => {
    const { call, store } = await setup({ decision: "require_approval" })
    const body = { alias: aliasForConnection(connection), tool: "sendEmail", arguments: { to: "a@b.c" } }
    const responses = await Promise.all(Array.from({ length: 8 }, () => call("POST", "/v1/execute", { body })))
    expect(responses.every((response) => response.status === 200)).toBe(true)
    expect(new Set(responses.map((response) => response.body["approvalId"])).size).toBe(1)
    expect(await run(store.listApprovals(defaultTenantId))).toHaveLength(1)
  })

  test("shared profiles cannot share or collect another client's approval", async () => {
    const { call, store, accessProfile, approvalPolicy } = await setup({ decision: "require_approval" })
    const other = await run(store.createClient({
      id: (await run(newClientId)), tenantId: defaultTenantId, accessProfileId: accessProfile.id,
      approvalPolicyId: approvalPolicy.id, name: "other-agent", capabilities: []
    }))
    const key = (await run(generateApiKey))
    await run(store.addApiKey({ id: key.id, clientId: other.id, hash: key.hash }))
    const body = { alias: aliasForConnection(connection), tool: "sendEmail", arguments: { to: "a@b.c" } }
    const first = await call("POST", "/v1/execute", { body })
    const second = await call("POST", "/v1/execute", { body, secret: key.secret })
    expect(second.body["approvalId"]).not.toBe(first.body["approvalId"])
    await call("POST", `/v1/approvals/${String(first.body["approvalId"])}/approve`, { body: {}, local: true })
    const retry = await call("POST", "/v1/execute", { body, secret: key.secret })
    expect(retry.body["status"]).toBe("pending")
    expect(retry.body["approvalId"]).toBe(second.body["approvalId"])
    expect((await call("POST", "/v1/execute", { body })).body["status"]).toBe("succeeded")
  })

  test("the same tool and arguments on different accounts keep distinct approvals and targets", async () => {
    const { call, store, accessProfile, approvalPolicy, calls } = await setup({ decision: "require_approval" })
    const personal = { ...connection, name: ConnectionName.make("personal") }
    const tools = [connection, personal].map((connection) => ({ connection, tool: ToolName.make("sendEmail") }))
    await run(store.replaceAccessProfileTools(accessProfile.id, tools))
    await run(store.replaceApprovalPolicyTools(approvalPolicy.id, tools.map((tool) => ({ ...tool, decision: "require_approval" }))))
    const first = await call("POST", "/v1/execute", { body: { alias: aliasForConnection(connection), tool: "sendEmail", arguments: { to: "a@b.c" } } })
    const second = await call("POST", "/v1/execute", { body: { alias: aliasForConnection(personal), tool: "sendEmail", arguments: { to: "a@b.c" } } })
    expect(second.body["approvalId"]).not.toBe(first.body["approvalId"])
    const response = await call("POST", `/v1/approvals/${String(second.body["approvalId"])}/approve`, { body: {}, local: true })
    expect(response.status).toBe(200)
    expect(calls).toEqual([{ address: "tools.gmail.user.personal.sendEmail", input: { to: "a@b.c" } }])
  })

  test("concurrent decisions cannot execute twice, deny an executing call, or collect it early", async () => {
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const { call, calls, store } = await setup({ decision: "require_approval", beforeExecute: () => {
      started.resolve()
      return release.promise
    } })
    const body = { alias: aliasForConnection(connection), tool: "sendEmail" }
    const frozen = await call("POST", "/v1/execute", { body })
    const id = String(frozen.body["approvalId"])
    const approving = call("POST", `/v1/approvals/${id}/approve`, { body: {}, local: true })
    try {
      await started.promise
      const [approve, deny, retry] = await Promise.all([
        call("POST", `/v1/approvals/${id}/approve`, { body: {}, local: true }),
        call("POST", `/v1/approvals/${id}/deny`, { body: {}, local: true }),
        call("POST", "/v1/execute", { body })
      ])
      expect(approve.status).toBe(400)
      expect(deny.status).toBe(400)
      expect(retry.body["approvalId"]).toBe(id)
      expect(retry.body["status"]).toBe("pending")
      expect(await run(store.expireApprovals(new Date(Date.now() + 86400000)))).toBe(0)
      expect(calls).toHaveLength(1)
    } finally {
      release.resolve()
      await approving
    }
    expect((await call("POST", "/v1/execute", { body })).body["status"]).toBe("succeeded")
    expect(calls).toHaveLength(1)
  })

  test("a durable execution claim survives reopening the store and cannot be replayed", async () => {
    const { call, store, calls } = await setup({ decision: "require_approval" })
    const body = { alias: aliasForConnection(connection), tool: "sendEmail" }
    const frozen = await call("POST", "/v1/execute", { body })
    const approval = (await run(store.listApprovals(defaultTenantId)))[0]
    if (approval === undefined) throw new Error("Missing approval")
    await run(store.claimApproval({ tenantId: defaultTenantId, id: approval.id, decidedBy: "human" }))
    const reopened = await run(createGatewayStore(store.databasePath))
    try {
      expect((await run(reopened.getApproval(defaultTenantId, approval.id)))?.status).toBe("executing")
      expect(await run(reopened.claimApproval({ tenantId: defaultTenantId, id: approval.id, decidedBy: "human" }))).toBe(false)
      expect(await run(reopened.collectApproval(defaultTenantId, approval.id))).toBe(false)
    } finally {
      await run(reopened.close())
    }
    expect((await call("POST", `/v1/approvals/${String(frozen.body["approvalId"])}/approve`, { body: {}, local: true })).status).toBe(400)
    expect((await call("POST", "/v1/execute", { body })).body["approvalId"]).toBe(approval.id)
    expect(calls).toHaveLength(0)
  })

  test("an administrative API key cannot make a human approval decision", async () => {
    const { call, calls } = await run(setup({
      decision: "require_approval",
      capabilities: ["provision_connections", "administer_gateway"]
    }))
    const frozen = await run(call("POST", "/v1/execute", {
      body: { alias: "user_sebastian_gmail_work", tool: "sendEmail" }
    }))
    const approvalId = String(frozen.body["approvalId"])

    const approved = await run(call("POST", `/v1/approvals/${approvalId}/approve`, {
      body: { decidedBy: "api-key" }
    }))
    const denied = await run(call("POST", `/v1/approvals/${approvalId}/deny`, {
      body: { decidedBy: "api-key" }
    }))

    expect(approved.status).toBe(403)
    expect(denied.status).toBe(403)
    expect(calls).toHaveLength(0)
  })

  test("the gateway performs the call itself once approved", async () => {
    const { call, calls } = await run(setup({ decision: "require_approval", capabilities: ["provision_connections", "administer_gateway"] }))
    const frozen = await run(call("POST", "/v1/execute", {
      body: { alias: "user_sebastian_gmail_work", tool: "sendEmail", arguments: { to: "a@b.c" } }
    }))
    const approvalId = String(frozen.body["approvalId"])
    expect(calls).toHaveLength(0)

    const approved = await run(call("POST", `/v1/approvals/${approvalId}/approve`, {
      body: { decidedBy: "sebastian" },
      local: true
    }))

    expect(approved.status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.input).toEqual({ to: "a@b.c" })
  })

  test("refuses to approve twice", async () => {
    const { call } = await run(setup({ decision: "require_approval", capabilities: ["provision_connections", "administer_gateway"] }))
    const frozen = await run(call("POST", "/v1/execute", {
      body: { alias: "user_sebastian_gmail_work", tool: "sendEmail" }
    }))
    const approvalId = String(frozen.body["approvalId"])

    expect((await run(call(
      "POST",
      `/v1/approvals/${approvalId}/approve`,
      { body: {}, local: true }
    ))).status).toBe(200)
    expect((await run(call(
      "POST",
      `/v1/approvals/${approvalId}/approve`,
      { body: {}, local: true }
    ))).status).toBe(400)
  })

  test("refuses to approve a call removed by access profile reassignment while frozen", async () => {
    const { call, store, client, calls } = await run(setup({
      decision: "require_approval",
      capabilities: ["provision_connections", "administer_gateway"]
    }))
    const frozen = await run(call("POST", "/v1/execute", {
      body: { alias: "user_sebastian_gmail_work", tool: "sendEmail" }
    }))
    const approvalId = String(frozen.body["approvalId"])

    const emptyProfile = await run(store.createAccessProfile({
      id: (await run(newAccessProfileId)),
      tenantId: defaultTenantId,
      name: "No mail access"
    }))
    await run(store.assignAccessProfile(defaultTenantId, client.id, emptyProfile.id))
    const approved = await run(call(
      "POST",
      `/v1/approvals/${approvalId}/approve`,
      { body: {}, local: true }
    ))

    expect(approved.status).toBe(400)
    expect(calls).toHaveLength(0)
  })

  test("refuses to approve a tool removed while the call was frozen", async () => {
    const { call, store, accessProfile, calls } = await run(setup({
      decision: "require_approval",
      capabilities: ["provision_connections", "administer_gateway"]
    }))
    const frozen = await run(call("POST", "/v1/execute", {
      body: { alias: "user_sebastian_gmail_work", tool: "sendEmail" }
    }))
    const approvalId = String(frozen.body["approvalId"])
    await run(store.replaceAccessProfileTools(accessProfile.id, []))

    const approved = await run(call(
      "POST",
      `/v1/approvals/${approvalId}/approve`,
      { body: {}, local: true }
    ))

    expect(approved.status).toBe(400)
    expect(calls).toHaveLength(0)
  })

  test("denying settles without performing the call", async () => {
    const { call, calls } = await run(setup({ decision: "require_approval", capabilities: ["provision_connections", "administer_gateway"] }))
    const frozen = await run(call("POST", "/v1/execute", {
      body: { alias: "user_sebastian_gmail_work", tool: "sendEmail" }
    }))
    const approvalId = String(frozen.body["approvalId"])

    const denied = await run(call("POST", `/v1/approvals/${approvalId}/deny`, {
      body: { decidedBy: "sebastian" },
      local: true
    }))

    expect(denied.status).toBe(200)
    expect(calls).toHaveLength(0)
  })
})

describe("frozen calls and retries", () => {
  const send = (
    call: Awaited<ReturnType<typeof setup>>["call"],
    args: Record<string, typeof Schema.Json.Type> = { to: "a@b.c" }
  ) => call("POST", "/v1/execute", {
    body: { alias: "user_sebastian_gmail_work", tool: "sendEmail", arguments: args }
  })

  test("a retry meets the frozen call it already proposed", async () => {
    const { call, store } = await run(setup({ decision: "require_approval", capabilities: ["provision_connections", "administer_gateway"] }))

    const first = await run(send(call))
    const second = await run(send(call))
    const third = await run(call("POST", "/v1/execute", {
      body: { alias: "user_sebastian_gmail_work", tool: "sendEmail", arguments: { to: "a@b.c" } }
    }))

    expect(second.body["approvalId"]).toBe(first.body["approvalId"])
    expect(third.body["approvalId"]).toBe(first.body["approvalId"])
    expect(await run(store.listApprovals(defaultTenantId, "pending"))).toHaveLength(1)
  })

  test("different arguments are a different frozen call", async () => {
    const { call, store } = await run(setup({ decision: "require_approval", capabilities: ["provision_connections", "administer_gateway"] }))

    const first = await run(send(call, { to: "a@b.c" }))
    const second = await run(send(call, { to: "someone-else@b.c" }))

    expect(second.body["approvalId"]).not.toBe(first.body["approvalId"])
    expect(await run(store.listApprovals(defaultTenantId, "pending"))).toHaveLength(2)
  })

  test("the retry after approval collects the result exactly once", async () => {
    const { call, store, calls } = await run(setup({ decision: "require_approval", capabilities: ["provision_connections", "administer_gateway"] }))
    const frozen = await run(send(call))
    const approvalId = String(frozen.body["approvalId"])
    await run(call("POST", `/v1/approvals/${approvalId}/approve`, {
      body: {},
      local: true
    }))
    expect(calls).toHaveLength(1)

    const collected = await run(send(call))
    expect(collected.body["status"]).toBe("succeeded")
    expect(collected.body["result"]).toEqual({ ok: true })
    expect(calls).toHaveLength(1)

    const afterCollection = await run(send(call))
    expect(afterCollection.body["status"]).toBe("pending")
    expect(afterCollection.body["approvalId"]).not.toBe(approvalId)
    expect(await run(store.listApprovals(defaultTenantId, "pending"))).toHaveLength(1)
  })

  test("a denial is delivered to the caller rather than left pending forever", async () => {
    const { call } = await run(setup({ decision: "require_approval", capabilities: ["provision_connections", "administer_gateway"] }))
    const frozen = await run(send(call))
    const approvalId = String(frozen.body["approvalId"])
    await run(call("POST", `/v1/approvals/${approvalId}/deny`, {
      body: { decidedBy: "sebastian" },
      local: true
    }))

    const collected = await run(send(call))

    expect(collected.status).toBe(403)
    expect(collected.body["status"]).toBe("denied")
    expect(String(collected.body["reason"])).toContain("local:support-agent")
    expect(String(collected.body["reason"])).not.toContain("sebastian")
  })

  test("the caller can read its own frozen call without an administrative key", async () => {
    const { call } = await run(setup({ decision: "require_approval" }))
    const frozen = await run(send(call))

    const polled = await run(call("GET", `/v1/approvals/${String(frozen.body["approvalId"])}`))

    expect(polled.status).toBe(200)
    expect(polled.body["status"]).toBe("pending")
    expect(polled.body["collectedAt"]).toBeNull()
  })
})

describe("provisioning surface", () => {
  test("validates the node shape a workflow actually authors", async () => {
    const { call } = await run(setup({
      capabilities: ["provision_connections", "administer_gateway"],
      tools: [{ address: "tools.gmail.user.work.sendEmail", name: "sendEmail" }]
    }))

    const report = await run(call("POST", "/v1/validate", {
      body: { node: { source: { kind: "gateway", alias: "user_sebastian_gmail_work", tool: "sendEmail" } } }
    }))

    expect(report.status).toBe(200)
    expect(report.body["ok"]).toBe(true)
    const checks = Schema.decodeUnknownSync(
      Schema.Array(Schema.Struct({ check: Schema.String }))
    )(report.body["findings"]).map((finding) => finding.check)
    expect(checks).toEqual(["structural", "authorization", "catalog"])
  })

  test("reports an alias this key does not hold", async () => {
    const { call } = await run(setup({ capabilities: ["provision_connections", "administer_gateway"] }))

    const report = await run(call("POST", "/v1/validate", {
      body: { node: { source: { kind: "gateway", alias: "user_sebastian_gmail_work", tool: "deleteEverything" } } }
    }))

    expect(report.body["ok"]).toBe(false)
    expect(JSON.stringify(report.body)).toContain("not authorized")
  })

  test("supports creating a client with explicit reusable configurations", async () => {
    const { call } = await run(setup({ capabilities: ["provision_connections", "administer_gateway"] }))
    const profile = await run(call("POST", "/v1/access-profiles", { body: { name: "Explicit access" } }))
    const policy = await run(call("POST", "/v1/approval-policies", { body: { name: "Explicit approval" } }))
    const response = await run(call("POST", "/v1/clients", {
      body: {
        name: "explicit-client",
        accessProfileId: String(profile.body["id"]),
        approvalPolicyId: String(policy.body["id"])
      }
    }))

    expect(profile.status).toBe(201)
    expect(policy.status).toBe(201)
    expect(response.status).toBe(201)
    expect(response.body["accessProfileId"]).toBe(profile.body["id"])
    expect(response.body["approvalPolicyId"]).toBe(policy.body["id"])
  })

  test("removes a connection by the name it was asked for, not the stored one", async () => {
    const { call, removed } = await run(setup({
      capabilities: ["provision_connections", "administer_gateway"],
      connections: [{ integration: "gmail", name: "docs_demo" }]
    }))

    const response = await run(call("DELETE", "/v1/connections/gmail/docs-demo"))

    expect(response.status).toBe(200)
    expect(response.body["connection"]).toBe("docs_demo")
    expect(removed).toEqual([{ integration: "gmail", name: "docs_demo" }])
  })

  test("removing an integration takes its connections and their policy rules", async () => {
    const { call, store, accessProfile, approvalPolicy, forgotten } = await run(setup({
      capabilities: ["provision_connections", "administer_gateway"],
      connections: [{ integration: "gmail", name: "work" }]
    }))

    expect(await run(store.listAccessProfileTools(accessProfile.id))).toHaveLength(1)
    expect(await run(store.listApprovalPolicyTools(approvalPolicy.id))).toHaveLength(1)

    const response = await run(call("DELETE", "/v1/integrations/gmail"))

    expect(response.status).toBe(200)
    expect(forgotten).toEqual(["gmail"])
    expect(response.body["connections"]).toEqual(["work"])
    expect(await run(store.listAccessProfileTools(accessProfile.id))).toEqual([])
    expect(await run(store.listApprovalPolicyTools(approvalPolicy.id))).toEqual([])
  })

  test("renames an integration without moving its slug", async () => {
    const { call, renamed } = await run(setup({
      capabilities: ["provision_connections", "administer_gateway"],
      connections: [{ integration: "statelessserver", name: "default" }]
    }))

    const response = await run(call("POST", "/v1/integrations/statelessserver/name", {
      body: { name: "Gmail" }
    }))

    expect(response.status).toBe(200)
    expect(response.body["name"]).toBe("Gmail")
    expect(response.body["slug"]).toBe("statelessserver")
    expect(renamed).toEqual([{ slug: "statelessserver", name: "Gmail" }])
  })

  test("refuses to rename an integration it never installed", async () => {
    const { call, renamed } = await run(setup({
      capabilities: ["provision_connections", "administer_gateway"],
      connections: [{ integration: "gmail", name: "work" }]
    }))

    const response = await run(call("POST", "/v1/integrations/notion/name", {
      body: { name: "Notion" }
    }))

    expect(response.status).toBe(404)
    expect(renamed).toEqual([])
  })

  test("refuses to remove an integration it never installed", async () => {
    const { call, forgotten } = await run(setup({
      capabilities: ["provision_connections", "administer_gateway"],
      connections: [{ integration: "gmail", name: "work" }]
    }))

    const response = await run(call("DELETE", "/v1/integrations/notion"))

    expect(response.status).toBe(404)
    expect(forgotten).toEqual([])
  })

  test("says which connections exist when none matches", async () => {
    const { call } = await run(setup({
      capabilities: ["provision_connections", "administer_gateway"],
      connections: [{ integration: "gmail", name: "work" }]
    }))

    const response = await run(call("DELETE", "/v1/connections/gmail/personal"))

    expect(response.status).toBe(404)
    expect(String(response.body["error"])).toContain("work")
  })

  test("lists a client's keys without their hashes, and revokes one", async () => {
    const { call, client, key, store } = await run(setup({ capabilities: ["provision_connections", "administer_gateway"] }))

    const listed = await run(call("GET", `/v1/clients/${client.id}/keys`))
    const keys = Schema.decodeUnknownSync(Schema.Array(JsonBody))(listed.body["keys"])
    expect(keys).toHaveLength(1)
    expect(keys[0]?.["id"]).toBe(key.id)
    expect(JSON.stringify(keys)).not.toContain(key.hash)

    const revoked = await run(call("POST", `/v1/keys/${key.id}/revoke`))
    expect(revoked.status).toBe(200)
    const after = await run(store.listApiKeys(client.id))
    expect(after[0]?.revokedAt).not.toBeNull()
  })

  test("names the MCP endpoint alongside the clients that connect to it", async () => {
    const { call } = await run(setup({
      capabilities: ["provision_connections", "administer_gateway"],
      mcpUrl: "https://gateway.example/mcp"
    }))

    const response = await run(call("GET", "/v1/clients"))

    expect(response.status).toBe(200)
    expect(response.body["mcpUrl"]).toBe("https://gateway.example/mcp")
  })

  test("omits the MCP endpoint when the gateway has no public origin to name", async () => {
    const { call } = await run(setup({ capabilities: ["provision_connections", "administer_gateway"] }))

    const response = await run(call("GET", "/v1/clients"))

    expect(response.status).toBe(200)
    expect(response.body["mcpUrl"]).toBeUndefined()
  })

  test("reads another client's effective surface, so codegen does not need its key", async () => {
    const { call, client } = await run(setup({ capabilities: ["provision_connections", "administer_gateway"] }))

    const response = await run(call("GET", `/v1/clients/${client.id}/tools`))

    expect(response.status).toBe(200)
    expect(response.body["tools"]).toEqual([
      {
        alias: "user_sebastian_gmail_work",
        tool: "sendEmail",
        connection: { owner: "user", subject: "sebastian", integration: "gmail", name: "work" },
        decision: "allow"
      }
    ])
  })

  test("filters and windows the audit trail, and says how much there is", async () => {
    const { call } = await run(setup({ capabilities: ["provision_connections", "administer_gateway"] }))
    await run(call("POST", "/v1/execute", { body: { alias: "user_sebastian_gmail_work", tool: "sendEmail" } }))
    await run(call("POST", "/v1/execute", { body: { alias: "user_sebastian_gmail_work", tool: "nope" } }))

    const all = await run(call("GET", "/v1/audit"))
    expect(all.body["total"]).toBe(2)

    const denied = await run(call("GET", "/v1/audit?outcome=denied"))
    expect(denied.body["total"]).toBe(1)
    expect(Schema.decodeUnknownSync(Schema.Array(Schema.Json))(denied.body["records"])).toHaveLength(1)

    const windowed = await run(call("GET", "/v1/audit?limit=1&offset=1"))
    expect(windowed.body["total"]).toBe(2)
    expect(windowed.body["offset"]).toBe(1)
    expect(Schema.decodeUnknownSync(Schema.Array(Schema.Json))(windowed.body["records"])).toHaveLength(1)
  })

  test("refuses a window it cannot read rather than quietly serving another one", async () => {
    const { call } = await run(setup({ capabilities: ["provision_connections", "administer_gateway"] }))
    for (const query of ["limit=abc", "limit=0", "limit=1.5", "offset=-1", "since=nope"]) {
      expect((await run(call("GET", `/v1/audit?${query}`))).status).toBe(400)
    }
  })
})
