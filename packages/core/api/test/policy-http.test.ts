import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect, Schema } from "effect"
import { ToolAddress } from "@mokronos/contracts"
import type { IntegrationsApi } from "@mokronos/integrations"
import {
  AccessProfileId,
  ApprovalPolicyId,
  ClientId,
  createGatewayHandler,
  createGatewayStore,
  defaultTenantId,
  generateApiKey,
  newClientId,
  ToolName
} from "./gateway.ts"
import type { GatewayStore } from "./gateway.ts"
import { stubIntegrations } from "./stubs.ts"

const stores: Array<GatewayStore> = []
const directories: Array<string> = []
const run = Effect.runPromise
const ClientBody = Schema.decodeUnknownSync(Schema.Struct({
  id: ClientId, accessProfileId: AccessProfileId, approvalPolicyId: ApprovalPolicyId
}))
const AccessProfileBody = Schema.decodeUnknownSync(Schema.Struct({ id: AccessProfileId }))
const ApprovalPolicyBody = Schema.decodeUnknownSync(Schema.Struct({ id: ApprovalPolicyId }))
const ToolsBody = Schema.decodeUnknownSync(Schema.Struct({
  tools: Schema.Array(Schema.Struct({ alias: Schema.String, tool: Schema.String, decision: Schema.String }))
}))

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => run(store.close())))
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const setup = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "gateway-policy-http-"))
  directories.push(directory)
  const store = await run(createGatewayStore(path.join(directory, "gateway.sqlite")))
  stores.push(store)
  const accessProfile = await run(store.findDefaultAccessProfile(defaultTenantId))
  const approvalPolicy = await run(store.findDefaultApprovalPolicy(defaultTenantId))
  if (accessProfile === undefined || approvalPolicy === undefined) throw new Error("missing defaults")
  const administrator = await run(store.createClient({
    id: newClientId(), tenantId: defaultTenantId, accessProfileId: accessProfile.id,
    approvalPolicyId: approvalPolicy.id, name: "administrator", capabilities: ["administer_gateway"]
  }))
  const key = generateApiKey()
  await run(store.addApiKey({ id: key.id, clientId: administrator.id, hash: key.hash }))
  const base = stubIntegrations()
  const integrations: IntegrationsApi = {
    ...base,
    tools: {
      ...base.tools,
      summaries: async () => [{
        address: ToolAddress.make("tools.mail.org.primary.sendEmail"), name: "sendEmail",
        description: "Send mail", integration: "mail", owner: "org", connection: "primary",
        defaultDecision: "require_approval"
      }]
    }
  }
  const { handle } = createGatewayHandler({
    store, integrations, retentionDays: 30,
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
      headers: { authorization: `Bearer ${key.secret}`, "content-type": "application/json" }
    }
    if (body !== undefined) init.body = JSON.stringify(body)
    return handle(new Request(`http://gateway.test${pathname}`, init))
  }
  return { store, call }
}

describe("access profile and approval policy administration", () => {
  test("new clients independently inherit both defaults", async () => {
    const { store, call } = await setup()
    const first = ClientBody(await (await call("POST", "/v1/clients", { name: "first" })).json())
    const second = ClientBody(await (await call("POST", "/v1/clients", { name: "second" })).json())

    expect(first.accessProfileId).toBe(second.accessProfileId)
    expect(first.approvalPolicyId).toBe(second.approvalPolicyId)
    expect((await run(store.listAccessProfileTools(first.accessProfileId))).map((row) => row.tool)).toEqual([ToolName.make("sendEmail")])
    expect((await run(store.listApprovalPolicyTools(first.approvalPolicyId)))[0]?.decision).toBe("require_approval")
  })

  test("effective tools are the intersection of separately assigned resources", async () => {
    const { call } = await setup()
    const client = ClientBody(await (await call("POST", "/v1/clients", { name: "worker" })).json())
    const access = AccessProfileBody(await (await call("POST", "/v1/access-profiles", { name: "Mail" })).json())
    const approval = ApprovalPolicyBody(await (await call("POST", "/v1/approval-policies", { name: "Reviewed" })).json())
    const route = { connection: { owner: "org", integration: "mail", name: "primary" }, tool: "sendEmail" }
    expect((await call("POST", `/v1/access-profiles/${access.id}/tools`, { tools: [route] })).status).toBe(200)
    expect((await call("POST", `/v1/approval-policies/${approval.id}/tools`, { tools: [{ ...route, decision: "require_approval" }] })).status).toBe(200)
    expect((await call("POST", `/v1/clients/${client.id}/access-profile`, { accessProfileId: access.id })).status).toBe(200)
    expect((await call("POST", `/v1/clients/${client.id}/approval-policy`, { approvalPolicyId: approval.id })).status).toBe(200)

    const effective = ToolsBody(await (await call("GET", `/v1/clients/${client.id}/tools`)).json())
    expect(effective.tools).toEqual([{ alias: "org_mail_primary", tool: "sendEmail", decision: "require_approval" }])

    await call("POST", `/v1/approval-policies/${approval.id}/tools`, { tools: [] })
    expect(ToolsBody(await (await call("GET", `/v1/clients/${client.id}/tools`)).json()).tools).toEqual([])
  })

  test("editing one reusable profile changes every assigned client's reach", async () => {
    const { call } = await setup()
    const access = AccessProfileBody(await (await call("POST", "/v1/access-profiles", { name: "Shared" })).json())
    const approval = ApprovalPolicyBody(await (await call("POST", "/v1/approval-policies", { name: "Shared decisions" })).json())
    const clients = []
    for (const name of ["alpha", "beta"]) {
      clients.push(ClientBody(await (await call("POST", "/v1/clients", { name })).json()))
    }
    for (const client of clients) {
      await call("POST", `/v1/clients/${client.id}/access-profile`, { accessProfileId: access.id })
      await call("POST", `/v1/clients/${client.id}/approval-policy`, { approvalPolicyId: approval.id })
    }
    const route = { connection: { owner: "org", integration: "mail", name: "primary" }, tool: "sendEmail" }
    await call("POST", `/v1/approval-policies/${approval.id}/tools`, { tools: [{ ...route, decision: "allow" }] })
    await call("POST", `/v1/access-profiles/${access.id}/tools`, { tools: [route] })

    for (const client of clients) {
      expect(ToolsBody(await (await call("GET", `/v1/clients/${client.id}/tools`)).json()).tools).toHaveLength(1)
    }
  })
})
