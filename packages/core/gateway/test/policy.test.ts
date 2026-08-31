import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { Connection, ToolAddress } from "@mokronos/contracts"
import type { IntegrationsApi } from "@mokronos/integrations"
import {
  Alias,
  ClientId,
  ConnectionName,
  IntegrationSlug,
  PolicyId,
  ToolName,
  authorizeInvocation,
  createGatewayStore,
  defaultTenantId,
  generateApiKey,
  grantConnection,
  listEffectiveTools,
  newConnectionGrantId,
  newPolicyId,
  reconcileDefaultPolicy
} from "../src/index.ts"
import type { GatewayStore } from "../src/store.ts"

const directories: Array<string> = []
const stores: Array<GatewayStore> = []
const run = Effect.runPromise

interface TestPolicyCatalog {
  readonly tools: IntegrationsApi["tools"]
  readonly connections: Pick<IntegrationsApi["connections"], "list">
}

const orgConnection = (integration: string, name: string) => ({
  owner: "org",
  integration: IntegrationSlug.make(integration),
  name: ConnectionName.make(name)
} as const)

const connected = (integration: string, name = "primary"): typeof Connection.Type => ({
  owner: "org",
  name,
  integration,
  template: "none",
  address: `connections.${integration}.org.${name}`,
  provider: integration
})

const summary = (
  integration: string,
  connection: string,
  name: string,
  defaultDecision: "allow" | "require_approval" = "allow"
) => ({
  address: ToolAddress.make(`tools.${integration}.org.${connection}.${name}`),
  name,
  description: name,
  integration,
  owner: "org" as const,
  connection,
  defaultDecision
})

/** The stub honours the filter because production code relies on it: seeding
 * rules for one connection asks the catalog for exactly that connection, and a
 * stub that answers with everything would hide a bug where it does not. */
const catalog = (input: {
  readonly connections?: ReadonlyArray<readonly [string, string]>
  readonly tools?: ReadonlyArray<ReturnType<typeof summary>>
}): TestPolicyCatalog => ({
  connections: {
    list: async () =>
      (input.connections ?? []).map(([integration, name]) => connected(integration, name))
  },
  tools: {
    list: async () => [],
    summaries: async (filter) => (input.tools ?? []).filter((tool) =>
      (filter?.integration === undefined || tool.integration === filter.integration)
      && (filter?.connection === undefined || tool.connection === filter.connection)
      && (filter?.owner === undefined || tool.owner === filter.owner)),
    describe: async () => { throw new Error("not used") },
    execute: async () => ({})
  }
})

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => run(store.close())))
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })))
})

const openStore = async (): Promise<GatewayStore> => {
  const directory = await mkdtemp(path.join(tmpdir(), "gateway-policy-"))
  directories.push(directory)
  const store = await run(createGatewayStore(path.join(directory, "gateway.sqlite")))
  stores.push(store)
  return store
}

const clientOn = (store: GatewayStore, policyId: PolicyId, name: string) =>
  store.createClient({
    id: ClientId.make(`${name}-client`),
    tenantId: defaultTenantId,
    policyId,
    name,
    capabilities: []
  })

describe("tenant policies", () => {
  test("creates one reusable default policy for a fresh tenant", async () => {
    const store = await openStore()
    const policy = await run(store.findDefaultPolicy(defaultTenantId))
    expect(policy?.name).toBe("Default")
    expect((await run(store.listPolicies(defaultTenantId))).filter((entry) => entry.isDefault)).toHaveLength(1)
  })

  test("seeds one default policy rule per connection, each at its own default", async () => {
    const store = await openStore()
    const integrations = catalog({
      connections: [["mail", "primary"]],
      tools: [
        summary("mail", "primary", "sendEmail", "allow"),
        summary("mail", "secondary", "sendEmail", "require_approval")
      ]
    })
    const policy = await run(reconcileDefaultPolicy({
      store, integrations, tenantId: defaultTenantId
    }))
    if (policy === undefined) throw new Error("missing default policy")
    // The same vendor tool on two connections is two rules, so the safe
    // connection is not dragged down to the cautious one's decision.
    expect(await run(store.listPolicyTools(policy.id))).toEqual([
      {
        policyId: policy.id,
        connection: orgConnection("mail", "primary"),
        tool: ToolName.make("sendEmail"),
        enabled: true,
        decision: "allow"
      },
      {
        policyId: policy.id,
        connection: orgConnection("mail", "secondary"),
        tool: ToolName.make("sendEmail"),
        enabled: true,
        decision: "require_approval"
      }
    ])
  })

  test("adds newly connected safe tools without changing existing decisions", async () => {
    const store = await openStore()
    const policy = await run(store.findDefaultPolicy(defaultTenantId))
    if (policy === undefined) throw new Error("missing default policy")
    await run(store.replacePolicyTools(policy.id, [{
      connection: orgConnection("mail", "primary"),
      tool: ToolName.make("search"),
      enabled: true,
      decision: "require_approval"
    }]))

    await run(reconcileDefaultPolicy({
      store,
      integrations: catalog({
        connections: [["mail", "primary"], ["context7", "default"]],
        tools: [
          summary("mail", "primary", "search", "allow"),
          summary("context7", "default", "query-docs", "allow")
        ]
      }),
      tenantId: defaultTenantId
    }))

    expect(await run(store.listPolicyTools(policy.id))).toEqual([
      {
        policyId: policy.id,
        connection: orgConnection("context7", "default"),
        tool: ToolName.make("query-docs"),
        enabled: true,
        decision: "allow"
      },
      {
        policyId: policy.id,
        connection: orgConnection("mail", "primary"),
        tool: ToolName.make("search"),
        enabled: true,
        decision: "require_approval"
      }
    ])
  })

  test("leaves custom policies alone when the catalog gains a connection", async () => {
    const store = await openStore()
    const policy = await run(store.createPolicy({
      id: newPolicyId(), tenantId: defaultTenantId, name: "Mail only"
    }))
    await run(store.replacePolicyTools(policy.id, [{
      connection: orgConnection("mail", "primary"),
      tool: ToolName.make("sendEmail"),
      enabled: false,
      decision: "require_approval"
    }]))

    await run(reconcileDefaultPolicy({
      store,
      integrations: catalog({
        connections: [["mail", "primary"], ["calendar", "primary"]],
        tools: [
          summary("mail", "primary", "archiveEmail"),
          summary("calendar", "primary", "createEvent")
        ]
      }),
      tenantId: defaultTenantId
    }))

    // The default policy absorbs everything; a custom one is the operator's
    // and is never widened behind their back.
    const defaultPolicy = await run(store.findDefaultPolicy(defaultTenantId))
    if (defaultPolicy === undefined) throw new Error("missing default policy")
    expect((await run(store.listPolicyTools(defaultPolicy.id))).map((rule) => rule.tool).sort())
      .toEqual([ToolName.make("archiveEmail"), ToolName.make("createEvent")])
    expect(await run(store.listPolicyTools(policy.id))).toEqual([{
      policyId: policy.id,
      connection: orgConnection("mail", "primary"),
      tool: ToolName.make("sendEmail"),
      enabled: false,
      decision: "require_approval"
    }])
  })

  test("a client reaches nothing until it is granted a connection", async () => {
    const store = await openStore()
    const integrations = catalog({
      connections: [["mail", "primary"]],
      tools: [summary("mail", "primary", "sendEmail")]
    })
    const policy = await run(reconcileDefaultPolicy({
      store, integrations, tenantId: defaultTenantId
    }))
    if (policy === undefined) throw new Error("missing default policy")
    const client = await run(clientOn(store, policy.id, "fresh"))

    // Its policy governs the connection, but reach is the client's own.
    expect(await run(store.listGrants(client.id))).toEqual([])
    expect(await run(listEffectiveTools(store, client.id))).toEqual([])

    await run(grantConnection({
      store, integrations, client, connection: orgConnection("mail", "primary")
    }))

    expect((await run(listEffectiveTools(store, client.id))).map((tool) => [tool.alias, tool.tool]))
      .toEqual([[Alias.make("mail"), ToolName.make("sendEmail")]])
  })

  test("keeps the first alias when a second connection for the same integration is granted", async () => {
    const store = await openStore()
    const integrations = catalog({
      connections: [["mail", "work"], ["mail", "personal"]],
      tools: [
        summary("mail", "work", "sendEmail", "require_approval"),
        summary("mail", "personal", "sendEmail", "allow")
      ]
    })
    const policy = await run(reconcileDefaultPolicy({
      store, integrations, tenantId: defaultTenantId
    }))
    if (policy === undefined) throw new Error("missing default policy")
    const client = await run(clientOn(store, policy.id, "two-mailbox"))
    const key = generateApiKey()
    await run(store.addApiKey({ id: key.id, clientId: client.id, hash: key.hash }))

    const first = await run(grantConnection({
      store, integrations, client, connection: orgConnection("mail", "work")
    }))
    expect(first.grant.alias).toBe(Alias.make("mail"))

    const second = await run(grantConnection({
      store, integrations, client, connection: orgConnection("mail", "personal")
    }))

    // This is the whole point of storing the alias on the grant: the newcomer
    // takes a qualified name and the incumbent is left exactly as it was, so
    // the client's existing calls keep working.
    expect(second.grant.alias).toBe(Alias.make("mail-personal"))
    expect((await run(store.findGrantById(client.id, first.grant.id)))?.alias)
      .toBe(Alias.make("mail"))

    const work = await run(authorizeInvocation(store, {
      secret: key.secret, alias: Alias.make("mail"), tool: ToolName.make("sendEmail")
    }))
    const personal = await run(authorizeInvocation(store, {
      secret: key.secret, alias: Alias.make("mail-personal"), tool: ToolName.make("sendEmail")
    }))
    expect(work.status).toBe("authorized")
    expect(personal.status).toBe("authorized")
    if (work.status !== "authorized" || personal.status !== "authorized") return
    // The same operation, judged per credential.
    expect(work.decision).toBe("require_approval")
    expect(personal.decision).toBe("allow")
  })

  test("editing a policy never disturbs a client's grants or aliases", async () => {
    const store = await openStore()
    const integrations = catalog({
      connections: [["mail", "primary"]],
      tools: [summary("mail", "primary", "search")]
    })
    const policy = await run(reconcileDefaultPolicy({
      store, integrations, tenantId: defaultTenantId
    }))
    if (policy === undefined) throw new Error("missing default policy")
    const client = await run(clientOn(store, policy.id, "growing"))
    const { grant } = await run(grantConnection({
      store, integrations, client, connection: orgConnection("mail", "primary")
    }))

    await run(store.replacePolicyTools(policy.id, [
      {
        connection: orgConnection("mail", "primary"),
        tool: ToolName.make("search"),
        enabled: true,
        decision: "allow"
      },
      {
        connection: orgConnection("mail", "primary"),
        tool: ToolName.make("sendEmail"),
        enabled: true,
        decision: "require_approval"
      }
    ]))

    // The grant is untouched — same row, same alias — so approvals and audit
    // entries pointing at it still resolve. Only the tool set widened.
    const after = await run(store.listGrants(client.id))
    expect(after).toEqual([grant])
    expect((await run(listEffectiveTools(store, client.id))).map((tool) => tool.tool).sort())
      .toEqual([ToolName.make("search"), ToolName.make("sendEmail")])
  })

  test("a rule for an ungranted connection is invisible rather than an error", async () => {
    const store = await openStore()
    const integrations = catalog({
      connections: [["mail", "primary"], ["calendar", "primary"]],
      tools: [
        summary("mail", "primary", "sendEmail"),
        summary("calendar", "primary", "createEvent")
      ]
    })
    const policy = await run(reconcileDefaultPolicy({
      store, integrations, tenantId: defaultTenantId
    }))
    if (policy === undefined) throw new Error("missing default policy")
    const client = await run(clientOn(store, policy.id, "mail-only"))
    const key = generateApiKey()
    await run(store.addApiKey({ id: key.id, clientId: client.id, hash: key.hash }))
    await run(grantConnection({
      store, integrations, client, connection: orgConnection("mail", "primary")
    }))

    // One shared policy, two connections, one grant. The calendar rule exists
    // and governs nothing for this client.
    expect((await run(listEffectiveTools(store, client.id))).map((tool) => tool.integration))
      .toEqual([IntegrationSlug.make("mail")])
    expect((await run(authorizeInvocation(store, {
      secret: key.secret, alias: Alias.make("calendar"), tool: ToolName.make("createEvent")
    }))).status).toBe("not-authorized")
  })

  test("granting seeds a single-client policy in place", async () => {
    const store = await openStore()
    const integrations = catalog({
      connections: [["mail", "primary"]],
      tools: [summary("mail", "primary", "sendEmail")]
    })
    const policy = await run(store.createPolicy({
      id: newPolicyId(), tenantId: defaultTenantId, name: "Solo"
    }))
    const client = await run(clientOn(store, policy.id, "solo"))

    const outcome = await run(grantConnection({
      store, integrations, client, connection: orgConnection("mail", "primary")
    }))

    // Nobody else is on this policy, so there is nothing to protect from the
    // widening — forking would only create clutter.
    expect(outcome.seeding.kind).toBe("seeded-in-place")
    expect((await run(store.findClientById(defaultTenantId, client.id)))?.policyId).toBe(policy.id)
    expect((await run(store.listPolicyTools(policy.id))).map((rule) => rule.tool))
      .toEqual([ToolName.make("sendEmail")])
  })

  test("granting forks a shared policy instead of widening it for everyone", async () => {
    const store = await openStore()
    const integrations = catalog({
      connections: [["mail", "primary"], ["calendar", "primary"]],
      tools: [
        summary("mail", "primary", "sendEmail"),
        summary("calendar", "primary", "createEvent")
      ]
    })
    const shared = await run(store.createPolicy({
      id: newPolicyId(), tenantId: defaultTenantId, name: "Shared"
    }))
    await run(store.replacePolicyTools(shared.id, [{
      connection: orgConnection("mail", "primary"),
      tool: ToolName.make("sendEmail"),
      enabled: true,
      decision: "allow"
    }]))
    const alpha = await run(clientOn(store, shared.id, "alpha"))
    const beta = await run(clientOn(store, shared.id, "beta"))

    const outcome = await run(grantConnection({
      store, integrations, client: alpha, connection: orgConnection("calendar", "primary")
    }))

    expect(outcome.seeding.kind).toBe("forked")
    if (outcome.seeding.kind !== "forked") return
    expect(outcome.seeding.forkedFrom.id).toBe(shared.id)
    expect(outcome.seeding.policy.name).toBe("Shared (alpha)")
    expect(outcome.seeding.policy.forkedFrom).toBe(shared.id)

    // Alpha moved to the copy and can reach the calendar there...
    expect((await run(store.findClientById(defaultTenantId, alpha.id)))?.policyId)
      .toBe(outcome.seeding.policy.id)
    expect((await run(store.listPolicyTools(outcome.seeding.policy.id))).map((rule) => rule.tool).sort())
      .toEqual([ToolName.make("createEvent"), ToolName.make("sendEmail")])

    // ...while beta's policy is exactly what it was. Granting beta the same
    // connection later would be a separate, explicit decision.
    expect((await run(store.findClientById(defaultTenantId, beta.id)))?.policyId).toBe(shared.id)
    expect((await run(store.listPolicyTools(shared.id))).map((rule) => rule.tool))
      .toEqual([ToolName.make("sendEmail")])
  })

  test("granting the same connection twice keeps the alias it already has", async () => {
    const store = await openStore()
    const integrations = catalog({
      connections: [["mail", "primary"]],
      tools: [summary("mail", "primary", "sendEmail")]
    })
    const policy = await run(reconcileDefaultPolicy({
      store, integrations, tenantId: defaultTenantId
    }))
    if (policy === undefined) throw new Error("missing default policy")
    const client = await run(clientOn(store, policy.id, "repeat"))
    const first = await run(grantConnection({
      store, integrations, client, connection: orgConnection("mail", "primary")
    }))
    const again = await run(grantConnection({
      store, integrations, client, connection: orgConnection("mail", "primary")
    }))

    expect(again.existing).toBe(true)
    expect(again.grant.id).toBe(first.grant.id)
    expect(await run(store.listGrants(client.id))).toHaveLength(1)
  })

  test("keeps disabled tools explicit and denies them", async () => {
    const store = await openStore()
    const policy = await run(store.createPolicy({
      id: newPolicyId(), tenantId: defaultTenantId, name: "Disabled mail"
    }))
    await run(store.replacePolicyTools(policy.id, [{
      connection: orgConnection("mail", "primary"),
      tool: ToolName.make("sendEmail"),
      enabled: false,
      decision: "require_approval"
    }]))
    const client = await run(clientOn(store, policy.id, "disabled"))
    await run(store.createGrant({
      id: newConnectionGrantId(),
      tenantId: defaultTenantId,
      clientId: client.id,
      alias: Alias.make("mail"),
      connection: orgConnection("mail", "primary")
    }))
    const key = generateApiKey()
    await run(store.addApiKey({ id: key.id, clientId: client.id, hash: key.hash }))

    expect((await run(authorizeInvocation(store, {
      secret: key.secret,
      alias: Alias.make("mail"),
      tool: ToolName.make("sendEmail")
    }))).status).toBe("not-authorized")
    // Disabled is remembered, not forgotten: the rule survives the denial so an
    // operator can see the decision they made.
    expect(await run(store.listPolicyTools(policy.id))).toEqual([{
      policyId: policy.id,
      connection: orgConnection("mail", "primary"),
      tool: ToolName.make("sendEmail"),
      enabled: false,
      decision: "require_approval"
    }])
  })

  test("revoking a grant withdraws reach without touching the policy", async () => {
    const store = await openStore()
    const integrations = catalog({
      connections: [["mail", "primary"]],
      tools: [summary("mail", "primary", "sendEmail")]
    })
    const policy = await run(reconcileDefaultPolicy({
      store, integrations, tenantId: defaultTenantId
    }))
    if (policy === undefined) throw new Error("missing default policy")
    const client = await run(clientOn(store, policy.id, "revoked"))
    const { grant } = await run(grantConnection({
      store, integrations, client, connection: orgConnection("mail", "primary")
    }))
    const key = generateApiKey()
    await run(store.addApiKey({ id: key.id, clientId: client.id, hash: key.hash }))

    await run(store.revokeGrant(defaultTenantId, grant.id))

    expect((await run(authorizeInvocation(store, {
      secret: key.secret, alias: grant.alias, tool: ToolName.make("sendEmail")
    }))).status).toBe("not-authorized")
    expect(await run(store.listPolicyTools(policy.id))).toHaveLength(1)
  })

  test("replaces a policy's rules atomically", async () => {
    const store = await openStore()
    const policy = await run(store.createPolicy({
      id: newPolicyId(), tenantId: defaultTenantId, name: "Atomic"
    }))
    await run(store.replacePolicyTools(policy.id, [{
      connection: orgConnection("mail", "primary"),
      tool: ToolName.make("sendEmail"),
      enabled: false,
      decision: "allow"
    }]))
    const first = await run(store.findPolicy(defaultTenantId, policy.id))

    // An empty replacement is a policy that governs nothing, not a rejection.
    expect(await run(store.replacePolicyTools(policy.id, []))).toEqual([])
    expect(await run(store.listPolicyTools(policy.id))).toEqual([])
    // Every write moves the timestamp, so a concurrent editor can tell.
    expect((await run(store.findPolicy(defaultTenantId, policy.id)))!.updatedAt.getTime())
      .toBeGreaterThan((first?.updatedAt.getTime() ?? 0) - 1)
  })

  test("rejects assigning a policy across tenant boundaries", async () => {
    const store = await openStore()
    const otherTenant = await run(store.createTenant({ name: "Other" }))
    const defaultPolicy = await run(store.findDefaultPolicy(defaultTenantId))
    const otherPolicy = await run(store.findDefaultPolicy(otherTenant.id))
    if (defaultPolicy === undefined || otherPolicy === undefined) throw new Error("missing default policy")
    const client = await run(clientOn(store, defaultPolicy.id, "tenant"))
    await expect(run(store.assignPolicy(defaultTenantId, client.id, otherPolicy.id))).rejects.toBeDefined()
    expect((await run(store.findClientById(defaultTenantId, client.id)))?.policyId).toBe(defaultPolicy.id)
  })

})
