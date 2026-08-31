import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect, Schema } from "effect"
import { ToolAddress } from "@mokronos/contracts"
import type { IntegrationsApi } from "@mokronos/integrations"
import {
  ClientId,
  ConnectionGrantId,
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
  tools: Schema.Array(Schema.Struct({ policyId: PolicyId, enabled: Schema.Boolean }))
}))
const PolicyListBody = Schema.decodeUnknownSync(Schema.Struct({
  policies: Schema.Array(Schema.Struct({
    policy: Schema.Struct({ id: PolicyId }),
    connectionCount: Schema.Number,
    integrationCount: Schema.Number,
    toolCount: Schema.Number,
    enabledToolCount: Schema.Number
  }))
}))
const GrantsBody = Schema.decodeUnknownSync(Schema.Struct({
  grants: Schema.Array(Schema.Struct({ id: ConnectionGrantId, alias: Schema.String }))
}))
const GrantBody = Schema.decodeUnknownSync(Schema.Struct({
  grant: Schema.Struct({ id: ConnectionGrantId, alias: Schema.String }),
  existing: Schema.Boolean,
  seeding: Schema.Struct({ kind: Schema.String })
}))
const ToolsBody = Schema.decodeUnknownSync(Schema.Struct({
  tools: Schema.Array(Schema.Struct({ alias: Schema.String, tool: Schema.String }))
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
  test("reuses the seeded default policy and grants new clients nothing", async () => {
    const { store, call } = await setup()
    const firstResponse = await call("POST", "/v1/clients", { name: "first" })
    const secondResponse = await call("POST", "/v1/clients", { name: "second" })
    expect(firstResponse.status).toBe(201)
    expect(secondResponse.status).toBe(201)
    const first = ClientBody(await firstResponse.json())
    const second = ClientBody(await secondResponse.json())
    expect(first.policyId).toBe(second.policyId)
    expect((await run(store.listPolicyTools(first.policyId)))[0]?.decision).toBe("require_approval")
    // The policy governs the mail connection, but neither client reaches it
    // until someone hands it over.
    expect(await run(store.listGrants(first.id))).toHaveLength(0)
    expect(await run(store.listGrants(second.id))).toHaveLength(0)
  })

  test("creates, replaces, clones, assigns, and lists policies", async () => {
    const { call } = await setup()
    const clientResponse = await call("POST", "/v1/clients", { name: "worker" })
    const client = ClientBody(await clientResponse.json())
    const createdResponse = await call("POST", "/v1/policies", { name: "Reviewers" })
    expect(createdResponse.status).toBe(201)
    const policy = PolicyBody(await createdResponse.json())
    const mailConnection = { owner: "org", integration: "mail", name: "primary" }
    const toolsResponse = await call("POST", `/v1/policies/${policy.id}/tools`, {
      tools: [{ connection: mailConnection, tool: "sendEmail", enabled: false, decision: "allow" }]
    })
    const configured = PolicyToolsBody(await toolsResponse.json())
    expect(configured.tools[0]?.enabled).toBe(false)
    const cloneResponse = await call("POST", `/v1/policies/${policy.id}/clone`, {
      name: "Reviewers copy"
    })
    expect(cloneResponse.status).toBe(201)
    expect(PolicyToolsBody(await cloneResponse.json()).tools[0]?.enabled).toBe(false)
    const listResponse = await call("GET", "/v1/policies")
    const listed = PolicyListBody(await listResponse.json()).policies
      .find((entry) => entry.policy.id === policy.id)
    expect(listed?.enabledToolCount).toBe(0)
    expect(listed?.connectionCount).toBe(1)

    const assignedResponse = await call("POST", `/v1/clients/${client.id}/policy`, {
      policyId: policy.id
    })
    expect(ClientBody(await assignedResponse.json()).policyId).toBe(policy.id)
  })

  test("grants a connection, keeps its alias, and revokes it again", async () => {
    const { call } = await setup()
    const client = ClientBody(await (await call("POST", "/v1/clients", { name: "worker" })).json())

    const grantResponse = await call("POST", `/v1/clients/${client.id}/connections`, {
      integration: "mail",
      connection: "primary"
    })
    expect(grantResponse.status).toBe(201)
    const granted = GrantBody(await grantResponse.json())
    expect(granted.existing).toBe(false)
    expect(granted.grant.alias).toBe("mail")
    // The default policy already governs every connected credential, so nothing
    // had to be written and no fork was needed.
    expect(granted.seeding.kind).toBe("already-governed")

    const listed = GrantsBody(
      await (await call("GET", `/v1/clients/${client.id}/connections`)).json()
    ).grants
    expect(listed.map((grant) => grant.alias)).toEqual(["mail"])
    expect(ToolsBody(
      await (await call("GET", `/v1/clients/${client.id}/tools`)).json()
    ).tools.map((tool) => [tool.alias, tool.tool])).toEqual([["mail", "sendEmail"]])

    const renamed = await call(
      "POST",
      `/v1/clients/${client.id}/connections/${granted.grant.id}`,
      { alias: "work-mail" }
    )
    expect(renamed.status).toBe(200)
    expect(GrantsBody(
      await (await call("GET", `/v1/clients/${client.id}/connections`)).json()
    ).grants[0]?.alias).toBe("work-mail")

    const revoked = await call(
      "POST",
      `/v1/clients/${client.id}/connections/${granted.grant.id}/revoke`
    )
    expect(revoked.status).toBe(200)
    expect(GrantsBody(
      await (await call("GET", `/v1/clients/${client.id}/connections`)).json()
    ).grants).toHaveLength(0)
  })

  test("granting a connection a shared policy does not govern forks the policy", async () => {
    const { store, call } = await setup()
    const policy = PolicyBody(
      await (await call("POST", "/v1/policies", { name: "Shared" })).json()
    )
    const alpha = ClientBody(await (await call("POST", "/v1/clients", { name: "alpha" })).json())
    const beta = ClientBody(await (await call("POST", "/v1/clients", { name: "beta" })).json())
    for (const client of [alpha, beta]) {
      await call("POST", `/v1/clients/${client.id}/policy`, { policyId: policy.id })
    }

    const granted = GrantBody(await (await call(
      "POST",
      `/v1/clients/${alpha.id}/connections`,
      { integration: "mail", connection: "primary" }
    )).json())

    expect(granted.seeding.kind).toBe("forked")
    // Alpha moved to a copy; beta's policy is untouched and still governs
    // nothing, so beta gained no reach from alpha's grant.
    const alphaAfter = await run(store.findClientById(defaultTenantId, alpha.id))
    expect(alphaAfter?.policyId).not.toBe(policy.id)
    expect((await run(store.findClientById(defaultTenantId, beta.id)))?.policyId).toBe(policy.id)
    expect(await run(store.listPolicyTools(policy.id))).toHaveLength(0)
  })
})
