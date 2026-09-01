import { run, runAll } from "./effect.ts"
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect, Schema } from "effect"
import { ToolAddress, whenPresent } from "@mokronos/contracts"
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import type { IntegrationsApi } from "@mokronos/integrations"
import type { Connection, Tool } from "@mokronos/contracts"
import {
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

/** Members these tests never reach. Throwing is deliberate: a partial fake that
 *  returned `undefined` would let a handler quietly start depending on one of
 *  these and still pass. */
const notStubbed = (member: string) => () => {
  throw new Error(`stubIntegrations: ${member} is not stubbed for these tests`)
}

/** Fills in the fields a vendor connection always carries so a test only has to
 *  name the part it cares about. */
const stubConnection = (
  reference: { readonly integration: string; readonly name: string }
): Connection => ({
  owner: "user",
  name: reference.name,
  integration: reference.integration,
  template: reference.integration,
  address: `connections.${reference.integration}.user.${reference.name}`,
  provider: reference.integration
})

/** Fills in a tool's descriptive fields, which these tests never assert on. */
const stubTool = (
  tool: {
    readonly address: string
    readonly name: string
    readonly owner?: "org" | "user"
    readonly defaultDecision?: "allow" | "require_approval"
  }
): Tool => ({
  address: ToolAddress.make(tool.address),
  name: tool.name,
  description: "",
  integration: "gmail",
  owner: tool.owner ?? "user",
  connection: "work",
  defaultDecision: tool.defaultDecision ?? "require_approval"
})

/** A stand-in for the host's tool surface. The gateway's job is deciding
 *  whether a call happens and with which credential — not what the vendor
 *  returns — so the tests assert on which address was reached. */
const stubIntegrations = (behaviour: {
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
  const integrations: IntegrationsApi = {
    tools: {
      execute: async (address, input) => {
        calls.push({ address: String(address), input })
        if (behaviour.fail === true) throw new Error("vendor exploded")
        return { ok: true }
      },
      summaries: async () => (behaviour.tools ?? []).map(stubTool),
      describe: async (address) => ({
        ...stubTool({
          address: String(address),
          name: String(address).split(".").at(-1) ?? "tool"
        }),
        description: "Send an email",
        inputSchema: {
          type: "object",
          properties: { to: { type: "string" } },
          required: ["to"]
        }
      }),
      list: async () => (behaviour.tools ?? []).map(stubTool)
    },
    connections: {
      list: async () => (behaviour.connections ?? []).map(stubConnection),
      remove: async (reference) => {
        removed.push({ integration: reference.integration, name: reference.name })
      },
      create: notStubbed("connections.create"),
      ensure: notStubbed("connections.ensure")
    },
    catalog: {
      classify: notStubbed("catalog.classify"),
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
    provisioning: {
      install: notStubbed("provisioning.install"),
      provision: notStubbed("provisioning.provision")
    },
    validateIntegrationNode: notStubbed("validateIntegrationNode"),
    listIntegrationOverviews: async () => []
  }
  return { calls, removed, integrations }
}

const setup = async (options: {
  readonly decision?: "allow" | "require_approval"
  readonly capabilities?: ReadonlyArray<"provision_connections" | "administer_gateway">
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
    id: newAccessProfileId(), tenantId: defaultTenantId, name: `access-${crypto.randomUUID()}`
  }))
  await run(store.replaceAccessProfileTools(accessProfile.id, [{
      connection,
      tool: ToolName.make("sendEmail")
    }]))
  const approvalPolicy = await run(store.createApprovalPolicy({
    id: newApprovalPolicyId(), tenantId: defaultTenantId, name: `approval-${crypto.randomUUID()}`
  }))
  await run(store.replaceApprovalPolicyTools(approvalPolicy.id, [{
      connection,
      tool: ToolName.make("sendEmail"),
      decision: options.decision ?? "allow"
    }]))
  const client = await run(store.createClient({
    id: newClientId(),
    tenantId: defaultTenantId,
    accessProfileId: accessProfile.id,
    approvalPolicyId: approvalPolicy.id,
    name: "support-agent",
    capabilities: options.capabilities ?? ["provision_connections"]
  }))
  const key = generateApiKey()
  await run(store.addApiKey({ id: key.id, clientId: client.id, hash: key.hash }))
  const stub = stubIntegrations({
    ...whenPresent("fail", options.fail),
    ...whenPresent("connections", options.connections),
    ...whenPresent("tools", options.tools)
  })
  const { handle } = createGatewayHandler({
    store,
    integrations: stub.integrations,
    retentionDays: 30,
    // No OAuth flow is exercised here; these tests are about authority.
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
      readonly body?: unknown
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
    removed: stub.removed
  }
}

describe("gateway http surface", () => {
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
        name: "user--sebastian--gmail--work__sendEmail",
        description: "Send an email",
        inputSchema: expect.objectContaining({ type: "object" })
      })])

      const called = await run(client.callTool({
        name: "user--sebastian--gmail--work__sendEmail",
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
        alias: "user--sebastian--gmail--work",
        tool: "sendEmail",
        connection: { owner: "user", subject: "sebastian", integration: "gmail", name: "work" },
        decision: "allow"
      }
    ])
  })

  test("executes an effective tool against the address built from the access profile", async () => {
    const { call, calls } = await run(setup())

    const response = await run(call("POST", "/v1/execute", {
      body: { alias: "user--sebastian--gmail--work", tool: "sendEmail", arguments: { to: "a@b.c" } }
    }))

    expect(response.status).toBe(200)
    expect(response.body["status"]).toBe("succeeded")
    // The address is derived from the profile, so a caller cannot forge one.
    expect(calls).toHaveLength(1)
    expect(calls[0]?.address).toBe("tools.gmail.user.work.sendEmail")
  })

  test("refuses an unauthorized tool without calling the vendor", async () => {
    const { call, calls } = await run(setup())

    const response = await run(call("POST", "/v1/execute", {
      body: { alias: "user--sebastian--gmail--work", tool: "deleteEverything" }
    }))

    expect(response.status).toBe(403)
    expect(calls).toHaveLength(0)
  })

  test("freezes a require_approval call instead of performing it", async () => {
    const { call, calls } = await run(setup({ decision: "require_approval" }))

    const response = await run(call("POST", "/v1/execute", {
      body: { alias: "user--sebastian--gmail--work", tool: "sendEmail", arguments: { to: "a@b.c" } }
    }))

    expect(response.status).toBe(200)
    expect(response.body["status"]).toBe("pending")
    expect(response.body["approvalId"]).toBeString()
    // Nothing reached the vendor: the call is frozen, not attempted.
    expect(calls).toHaveLength(0)
  })

  test("reports a vendor failure as 502 rather than a denial", async () => {
    const { call } = await run(setup({ fail: true }))

    const response = await run(call("POST", "/v1/execute", {
      body: { alias: "user--sebastian--gmail--work", tool: "sendEmail" }
    }))

    expect(response.status).toBe(502)
    expect(response.body["status"]).toBe("failed")
  })

  test("rejects a malformed body at the boundary", async () => {
    const { call } = await run(setup())
    const response = await run(call("POST", "/v1/execute", { body: { alias: "user--sebastian--gmail--work" } }))
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
      body: { alias: "user--sebastian--gmail--work", tool: "sendEmail" }
    }))
    const approvalId = String(frozen.body["approvalId"])

    const other = await run(store.createClient({
      id: newClientId(),
      tenantId: defaultTenantId,
      accessProfileId: accessProfile.id,
      approvalPolicyId: approvalPolicy.id,
      name: "someone-else",
      capabilities: ["provision_connections"]
    }))
    const otherKey = generateApiKey()
    await run(store.addApiKey({ id: otherKey.id, clientId: other.id, hash: otherKey.hash }))

    expect((await run(call("GET", `/v1/approvals/${approvalId}`))).status).toBe(200)
    const peek = await run(call("GET", `/v1/approvals/${approvalId}`, { secret: otherKey.secret }))
    // Reported as absent rather than forbidden, so existence does not leak.
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
        approvalDelivery: {
          returnLink: false,
          webhooks: ["https://automation.example/approvals"]
        }
      }
    }))
    expect(response.status).toBe(200)
    expect(response.body["capabilities"]).toEqual(["provision_connections"])
    expect(response.body["approvalDelivery"]).toEqual({
      returnLink: false,
      webhooks: ["https://automation.example/approvals"]
    })
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
      body: { alias: "user--sebastian--gmail--work", tool: "sendEmail" }
    }))
    expect(response.body["approvalUrl"]).toBe(
      `https://gateway.example/approvals?approval=${String(response.body["approvalId"])}`
    )
  })

  test("revoking a client through the API cancels its frozen calls", async () => {
    const { call, client } = await run(setup({ decision: "require_approval", capabilities: ["provision_connections", "administer_gateway"] }))
    await run(call("POST", "/v1/execute", { body: { alias: "user--sebastian--gmail--work", tool: "sendEmail" } }))

    const response = await run(call("POST", `/v1/clients/${client.id}/revoke`, { body: {} }))

    expect(response.status).toBe(200)
    expect(response.body["cancelledApprovals"]).toBe(1)
  })
})

describe("gateway approval settlement", () => {
  test("an administrative API key cannot make a human approval decision", async () => {
    const { call, calls } = await run(setup({
      decision: "require_approval",
      capabilities: ["provision_connections", "administer_gateway"]
    }))
    const frozen = await run(call("POST", "/v1/execute", {
      body: { alias: "user--sebastian--gmail--work", tool: "sendEmail" }
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
      body: { alias: "user--sebastian--gmail--work", tool: "sendEmail", arguments: { to: "a@b.c" } }
    }))
    const approvalId = String(frozen.body["approvalId"])
    expect(calls).toHaveLength(0)

    const approved = await run(call("POST", `/v1/approvals/${approvalId}/approve`, {
      body: { decidedBy: "sebastian" },
      local: true
    }))

    expect(approved.status).toBe(200)
    // Approving discharges one frozen invocation. The caller was never handed
    // the capability, and the frozen arguments are what ran.
    expect(calls).toHaveLength(1)
    expect(calls[0]?.input).toEqual({ to: "a@b.c" })
  })

  test("refuses to approve twice", async () => {
    const { call } = await run(setup({ decision: "require_approval", capabilities: ["provision_connections", "administer_gateway"] }))
    const frozen = await run(call("POST", "/v1/execute", {
      body: { alias: "user--sebastian--gmail--work", tool: "sendEmail" }
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
      body: { alias: "user--sebastian--gmail--work", tool: "sendEmail" }
    }))
    const approvalId = String(frozen.body["approvalId"])

    const emptyProfile = await run(store.createAccessProfile({
      id: newAccessProfileId(),
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
      body: { alias: "user--sebastian--gmail--work", tool: "sendEmail" }
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
      body: { alias: "user--sebastian--gmail--work", tool: "sendEmail" }
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
    body: { alias: "user--sebastian--gmail--work", tool: "sendEmail", arguments: args }
  })

  test("a retry meets the frozen call it already proposed", async () => {
    const { call, store } = await run(setup({ decision: "require_approval", capabilities: ["provision_connections", "administer_gateway"] }))

    const first = await run(send(call))
    const second = await run(send(call))
    // Key order is an artefact of how the caller built its JSON, not part of
    // what it asked for.
    const third = await run(call("POST", "/v1/execute", {
      body: { alias: "user--sebastian--gmail--work", tool: "sendEmail", arguments: { to: "a@b.c" } }
    }))

    expect(second.body["approvalId"]).toBe(first.body["approvalId"])
    expect(third.body["approvalId"]).toBe(first.body["approvalId"])
    // One decision to make, however many times the caller retried.
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
    // The gateway performed it at approval time, not on the caller's behalf.
    expect(calls).toHaveLength(1)

    const collected = await run(send(call))
    expect(collected.body["status"]).toBe("succeeded")
    expect(collected.body["result"]).toEqual({ ok: true })
    expect(calls).toHaveLength(1)

    // And the call after that is a new request, so it needs its own decision
    // rather than replaying a "yes" forever.
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
      body: { node: { source: { kind: "gateway", alias: "user--sebastian--gmail--work", tool: "sendEmail" } } }
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
      body: { node: { source: { kind: "gateway", alias: "user--sebastian--gmail--work", tool: "deleteEverything" } } }
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
      connections: [{ integration: "gmail", name: "docsDemo" }]
    }))

    const response = await run(call("DELETE", "/v1/connections/gmail/docs-demo"))

    expect(response.status).toBe(200)
    expect(response.body["connection"]).toBe("docsDemo")
    expect(removed).toEqual([{ integration: "gmail", name: "docsDemo" }])
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
    // Absent rather than null or a guess: the dashboard says so instead of
    // handing an operator an address that reaches nothing.
    expect(response.body["mcpUrl"]).toBeUndefined()
  })

  test("reads another client's effective surface, so codegen does not need its key", async () => {
    const { call, client } = await run(setup({ capabilities: ["provision_connections", "administer_gateway"] }))

    const response = await run(call("GET", `/v1/clients/${client.id}/tools`))

    expect(response.status).toBe(200)
    expect(response.body["tools"]).toEqual([
      {
        alias: "user--sebastian--gmail--work",
        tool: "sendEmail",
        connection: { owner: "user", subject: "sebastian", integration: "gmail", name: "work" },
        decision: "allow"
      }
    ])
  })

  test("filters and windows the audit trail, and says how much there is", async () => {
    const { call } = await run(setup({ capabilities: ["provision_connections", "administer_gateway"] }))
    await run(call("POST", "/v1/execute", { body: { alias: "user--sebastian--gmail--work", tool: "sendEmail" } }))
    await run(call("POST", "/v1/execute", { body: { alias: "user--sebastian--gmail--work", tool: "nope" } }))

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
