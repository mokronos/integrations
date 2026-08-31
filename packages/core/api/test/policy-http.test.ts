import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect, Schema } from "effect"
import { ToolAddress } from "@mokronos/contracts"
import type { IntegrationsApi } from "@mokronos/integrations"
import {
  ClientId,
  ClientToolBindingId,
  PolicyId,
  createGatewayHandler,
  createGatewayStore,
  defaultTenantId,
  generateApiKey,
  newClientId
} from "./gateway.ts"
import type { GatewayStore } from "./gateway.ts"
import { stubIntegrations } from "./stubs.ts"

const stores: Array<GatewayStore> = []
const directories: Array<string> = []
const run = Effect.runPromise

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => run(store.close())))
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })))
})

const ClientBody = Schema.decodeUnknownSync(Schema.Struct({ id: ClientId, policyId: PolicyId }))
const PolicyBody = Schema.decodeUnknownSync(Schema.Struct({ id: PolicyId }))
const PolicyToolsBody = Schema.decodeUnknownSync(Schema.Struct({
  policy: Schema.Struct({ id: PolicyId }),
  integrations: Schema.Array(Schema.Struct({ policyId: PolicyId, integration: Schema.String })),
  tools: Schema.Array(Schema.Struct({ policyId: PolicyId, enabled: Schema.Boolean }))
}))
const PolicyListBody = Schema.decodeUnknownSync(Schema.Struct({
  policies: Schema.Array(Schema.Struct({
    policy: Schema.Struct({ id: PolicyId }),
    integrationCount: Schema.Number,
    toolCount: Schema.Number,
    enabledToolCount: Schema.Number
  }))
}))
const BindingsBody = Schema.decodeUnknownSync(Schema.Struct({
  bindings: Schema.Array(Schema.Struct({ id: ClientToolBindingId, alias: Schema.String }))
}))

const setup = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "gateway-policy-http-"))
  directories.push(directory)
  const store = await run(createGatewayStore(path.join(directory, "gateway.sqlite")))
  stores.push(store)
  const defaultPolicy = await run(store.findDefaultPolicy(defaultTenantId))
  if (defaultPolicy === undefined) throw new Error("missing default policy")
  const administrator = await run(store.createClient({
    id: newClientId(),
    tenantId: defaultTenantId,
    policyId: defaultPolicy.id,
    name: "administrator",
    capabilities: ["administer_gateway"]
  }))
  const key = generateApiKey()
  await run(store.addApiKey({ id: key.id, clientId: administrator.id, hash: key.hash }))
  const baseIntegrations = stubIntegrations()
  const integrations: IntegrationsApi = {
    ...baseIntegrations,
    connections: {
      ...baseIntegrations.connections,
      list: async () => [{
        owner: "org",
        name: "primary",
        integration: "mail",
        template: "none",
        address: "connections.mail.org.primary",
        provider: "mail"
      }]
    },
    tools: {
      ...baseIntegrations.tools,
      summaries: async () => [{
        address: ToolAddress.make("tools.mail.org.primary.sendEmail"),
        name: "sendEmail",
        description: "Send mail",
        integration: "mail",
        owner: "org",
        connection: "primary",
        defaultDecision: "require_approval"
      }]
    }
  }
  const { handle } = createGatewayHandler({
    store,
    integrations,
    retentionDays: 30,
    oauth: {
      start: () => Effect.die(new Error("not used")),
      get: () => Effect.sync((): undefined => undefined),
      completeByState: () => Effect.sync((): undefined => undefined),
      stop: () => Effect.void
    }
  })
  const call = (method: string, pathname: string, body?: Schema.Json) => {
    const init: RequestInit = {
      method,
      headers: {
        authorization: `Bearer ${key.secret}`,
        "content-type": "application/json"
      }
    }
    if (body !== undefined) init.body = JSON.stringify(body)
    return handle(new Request(`http://gateway.test${pathname}`, init))
  }
  return { store, call }
}

describe("policy administration", () => {
  test("reuses the seeded default policy and creates effective bindings for new clients", async () => {
    const { store, call } = await setup()
    const firstResponse = await call("POST", "/v1/clients", { name: "first" })
    const secondResponse = await call("POST", "/v1/clients", { name: "second" })
    expect(firstResponse.status).toBe(201)
    expect(secondResponse.status).toBe(201)
    const first = ClientBody(await firstResponse.json())
    const second = ClientBody(await secondResponse.json())
    expect(first.policyId).toBe(second.policyId)
    expect((await run(store.listPolicyTools(first.policyId)))[0]?.decision).toBe("require_approval")
    expect(await run(store.listBindings(first.id))).toHaveLength(1)
    expect(await run(store.listBindings(second.id))).toHaveLength(1)
  })

  test("creates, replaces, clones, assigns, and lists client bindings", async () => {
    const { call } = await setup()
    const clientResponse = await call("POST", "/v1/clients", { name: "worker" })
    const client = ClientBody(await clientResponse.json())
    const createdResponse = await call("POST", "/v1/policies", { name: "Reviewers" })
    expect(createdResponse.status).toBe(201)
    const policy = PolicyBody(await createdResponse.json())
    const mailConnection = { owner: "org", integration: "mail", name: "primary" }
    const toolsResponse = await call("POST", `/v1/policies/${policy.id}/tools`, {
      integrations: ["mail"],
      tools: [{ connection: mailConnection, tool: "sendEmail", enabled: false, decision: "allow" }]
    })
    const configured = PolicyToolsBody(await toolsResponse.json())
    expect(configured.integrations).toHaveLength(1)
    expect(configured.tools[0]?.enabled).toBe(false)
    const cloneResponse = await call("POST", `/v1/policies/${policy.id}/clone`, {
      name: "Reviewers copy"
    })
    expect(cloneResponse.status).toBe(201)
    const clone = PolicyToolsBody(await cloneResponse.json())
    expect(clone.integrations).toHaveLength(1)
    expect(clone.tools[0]?.enabled).toBe(false)
    const listResponse = await call("GET", "/v1/policies")
    const listed = PolicyListBody(await listResponse.json()).policies
      .find((entry) => entry.policy.id === policy.id)
    expect(listed?.enabledToolCount).toBe(0)
    const assignedResponse = await call("POST", `/v1/clients/${client.id}/policy`, {
      policyId: policy.id
    })
    expect(ClientBody(await assignedResponse.json()).policyId).toBe(policy.id)
    // Assigning is the whole operation: the client's routes are re-derived from
    // the policy it now has. Its previous default-policy route is gone, and the
    // only rule here is disabled, so there is nothing left to call.
    const bindingsResponse = await call("GET", `/v1/clients/${client.id}/bindings`)
    expect(BindingsBody(await bindingsResponse.json()).bindings).toHaveLength(0)

    // Enabling the rule is likewise the whole operation — no separate step
    // creates the route.
    await call("POST", `/v1/policies/${policy.id}/tools`, {
      integrations: ["mail"],
      tools: [{ connection: mailConnection, tool: "sendEmail", enabled: true, decision: "allow" }]
    })
    const enabled = BindingsBody(
      await (await call("GET", `/v1/clients/${client.id}/bindings`)).json()
    ).bindings
    expect(enabled).toHaveLength(1)
    expect(enabled[0]?.alias).toBe("mail")
  })
})
