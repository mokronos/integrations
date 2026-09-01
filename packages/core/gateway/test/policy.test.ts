import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { ToolAddress } from "@mokronos/contracts"
import type { IntegrationsApi } from "@mokronos/integrations"
import {
  Alias,
  ClientId,
  ConnectionName,
  IntegrationSlug,
  ToolName,
  authorizeInvocation,
  createGatewayStore,
  defaultTenantId,
  generateApiKey,
  listEffectiveTools,
  newAccessProfileId,
  newApprovalPolicyId,
  reconcileDefaults
} from "../src/index.ts"
import type { AccessProfileId, ApprovalPolicyId, GatewayStore } from "../src/index.ts"

const directories: Array<string> = []
const stores: Array<GatewayStore> = []
const run = Effect.runPromise
const connection = (integration: string, name: string) => ({
  owner: "org" as const,
  integration: IntegrationSlug.make(integration),
  name: ConnectionName.make(name)
})
const summary = (integration: string, name: string, tool: string, defaultDecision: "allow" | "require_approval" = "allow") => ({
  address: ToolAddress.make(`tools.${integration}.org.${name}.${tool}`),
  name: tool,
  description: tool,
  integration,
  owner: "org" as const,
  connection: name,
  defaultDecision
})
const catalog = (tools: ReadonlyArray<ReturnType<typeof summary>>): Pick<IntegrationsApi, "tools"> => ({
  tools: {
    list: async () => [],
    summaries: async () => tools,
    describe: async () => { throw new Error("not used") },
    execute: async () => ({})
  }
})

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => run(store.close())))
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const openStore = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "gateway-policy-"))
  directories.push(directory)
  const store = await run(createGatewayStore(path.join(directory, "gateway.sqlite")))
  stores.push(store)
  return store
}

const createClient = async (store: GatewayStore, name: string, accessProfileId: AccessProfileId, approvalPolicyId: ApprovalPolicyId) => {
  const client = await run(store.createClient({
    id: ClientId.make(`${name}-client`), tenantId: defaultTenantId, name,
    accessProfileId, approvalPolicyId, capabilities: []
  }))
  const key = generateApiKey()
  await run(store.addApiKey({ id: key.id, clientId: client.id, hash: key.hash }))
  return { client, key }
}

describe("access profiles and approval policies", () => {
  test("reconciles both reusable defaults without overwriting operator decisions", async () => {
    const store = await openStore()
    const accessProfile = await run(store.findDefaultAccessProfile(defaultTenantId))
    const approvalPolicy = await run(store.findDefaultApprovalPolicy(defaultTenantId))
    if (accessProfile === undefined || approvalPolicy === undefined) throw new Error("missing defaults")
    await run(store.replaceApprovalPolicyTools(approvalPolicy.id, [{
      connection: connection("mail", "primary"), tool: ToolName.make("sendEmail"), decision: "require_approval"
    }]))

    await run(reconcileDefaults({
      store, tenantId: defaultTenantId,
      integrations: catalog([
        summary("mail", "primary", "sendEmail", "allow"),
        summary("calendar", "primary", "createEvent", "allow")
      ])
    }))

    expect((await run(store.listAccessProfileTools(accessProfile.id))).map((row) => row.tool).sort())
      .toEqual([ToolName.make("createEvent"), ToolName.make("sendEmail")])
    expect((await run(store.listApprovalPolicyTools(approvalPolicy.id))).map((row) => [row.tool, row.decision]).sort())
      .toEqual([[ToolName.make("createEvent"), "allow"], [ToolName.make("sendEmail"), "require_approval"]])
  })

  test("exposes and authorizes only the exact intersection", async () => {
    const store = await openStore()
    const accessProfile = await run(store.createAccessProfile({ id: newAccessProfileId(), tenantId: defaultTenantId, name: "Mail access" }))
    const approvalPolicy = await run(store.createApprovalPolicy({ id: newApprovalPolicyId(), tenantId: defaultTenantId, name: "Reviewed actions" }))
    await run(store.replaceAccessProfileTools(accessProfile.id, [
      { connection: connection("mail", "primary"), tool: ToolName.make("sendEmail") },
      { connection: connection("calendar", "primary"), tool: ToolName.make("createEvent") }
    ]))
    await run(store.replaceApprovalPolicyTools(approvalPolicy.id, [
      { connection: connection("mail", "primary"), tool: ToolName.make("sendEmail"), decision: "require_approval" },
      { connection: connection("mail", "primary"), tool: ToolName.make("archiveEmail"), decision: "allow" }
    ]))
    const { client, key } = await createClient(store, "intersection", accessProfile.id, approvalPolicy.id)

    expect(await run(listEffectiveTools(store, client.id))).toEqual([{
      alias: Alias.make("org--mail--primary"), tool: ToolName.make("sendEmail"),
      connection: connection("mail", "primary"),
      decision: "require_approval"
    }])
    expect((await run(authorizeInvocation(store, { secret: key.secret, alias: Alias.make("org--mail--primary"), tool: ToolName.make("sendEmail") }))).status).toBe("authorized")
    expect((await run(authorizeInvocation(store, { secret: key.secret, alias: Alias.make("org--calendar--primary"), tool: ToolName.make("createEvent") }))).status).toBe("not-authorized")
    expect((await run(authorizeInvocation(store, { secret: key.secret, alias: Alias.make("org--mail--primary"), tool: ToolName.make("archiveEmail") }))).status).toBe("not-authorized")
  })

  test("changing only the approval policy changes the decision without changing reach", async () => {
    const store = await openStore()
    const accessProfile = await run(store.createAccessProfile({ id: newAccessProfileId(), tenantId: defaultTenantId, name: "Mail" }))
    const approvalPolicy = await run(store.createApprovalPolicy({ id: newApprovalPolicyId(), tenantId: defaultTenantId, name: "Mail decisions" }))
    const route = { connection: connection("mail", "primary"), tool: ToolName.make("sendEmail") }
    await run(store.replaceAccessProfileTools(accessProfile.id, [route]))
    await run(store.replaceApprovalPolicyTools(approvalPolicy.id, [{ ...route, decision: "allow" }]))
    const { client } = await createClient(store, "decision", accessProfile.id, approvalPolicy.id)
    expect((await run(listEffectiveTools(store, client.id)))[0]?.decision).toBe("allow")

    await run(store.replaceApprovalPolicyTools(approvalPolicy.id, [{ ...route, decision: "require_approval" }]))
    expect((await run(listEffectiveTools(store, client.id)))[0]?.decision).toBe("require_approval")
  })

  test("editing a reusable profile has an explicit shared blast radius", async () => {
    const store = await openStore()
    const accessProfile = await run(store.createAccessProfile({ id: newAccessProfileId(), tenantId: defaultTenantId, name: "Shared access" }))
    const approvalPolicy = await run(store.createApprovalPolicy({ id: newApprovalPolicyId(), tenantId: defaultTenantId, name: "Shared decisions" }))
    const mail = { connection: connection("mail", "primary"), tool: ToolName.make("sendEmail") }
    const calendar = { connection: connection("calendar", "primary"), tool: ToolName.make("createEvent") }
    await run(store.replaceAccessProfileTools(accessProfile.id, [mail]))
    await run(store.replaceApprovalPolicyTools(approvalPolicy.id, [{ ...mail, decision: "allow" }, { ...calendar, decision: "allow" }]))
    const alpha = await createClient(store, "alpha", accessProfile.id, approvalPolicy.id)
    const beta = await createClient(store, "beta", accessProfile.id, approvalPolicy.id)

    await run(store.replaceAccessProfileTools(accessProfile.id, [mail, calendar]))

    expect((await run(listEffectiveTools(store, alpha.client.id))).map((row) => row.tool).sort())
      .toEqual([ToolName.make("createEvent"), ToolName.make("sendEmail")])
    expect((await run(listEffectiveTools(store, beta.client.id))).map((row) => row.tool).sort())
      .toEqual([ToolName.make("createEvent"), ToolName.make("sendEmail")])
  })

  test("rejects assigning either reusable configuration across tenants", async () => {
    const store = await openStore()
    const accessProfile = await run(store.findDefaultAccessProfile(defaultTenantId))
    const approvalPolicy = await run(store.findDefaultApprovalPolicy(defaultTenantId))
    const other = await run(store.createTenant({ name: "Other" }))
    const otherAccess = await run(store.findDefaultAccessProfile(other.id))
    const otherApproval = await run(store.findDefaultApprovalPolicy(other.id))
    if (accessProfile === undefined || approvalPolicy === undefined || otherAccess === undefined || otherApproval === undefined) throw new Error("missing defaults")
    const { client } = await createClient(store, "tenant", accessProfile.id, approvalPolicy.id)

    await expect(run(store.assignAccessProfile(defaultTenantId, client.id, otherAccess.id))).rejects.toBeDefined()
    await expect(run(store.assignApprovalPolicy(defaultTenantId, client.id, otherApproval.id))).rejects.toBeDefined()
  })
})
