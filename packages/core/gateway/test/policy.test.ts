import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient as createSqlClient } from "@libsql/client"
import { Effect } from "effect"
import { Connection, ToolAddress } from "@mokronos/contracts"
import type { IntegrationsApi } from "@mokronos/integrations"
import {
  Alias,
  ApprovalId,
  ClientToolBindingId,
  ClientId,
  ConnectionName,
  IntegrationSlug,
  PolicyId,
  ToolName,
  authorizeInvocation,
  createGatewayStore,
  defaultTenantId,
  ensureDefaultPolicyTools,
  generateApiKey,
  newClientToolBindingId,
  newPolicyId
} from "../src/index.ts"
import type { GatewayStore } from "../src/store.ts"

const directories: Array<string> = []
const stores: Array<GatewayStore> = []
const run = Effect.runPromise

interface TestPolicyCatalog {
  readonly tools: IntegrationsApi["tools"]
  readonly connections: Pick<IntegrationsApi["connections"], "list">
}

const connected = (integration: string): typeof Connection.Type => ({
  owner: "org",
  name: "primary",
  integration,
  template: "none",
  address: `connections.${integration}.org.primary`,
  provider: integration
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

describe("tenant policies", () => {
  test("creates one reusable default policy for a fresh tenant", async () => {
    const store = await openStore()
    const policy = await run(store.findDefaultPolicy(defaultTenantId))
    expect(policy?.name).toBe("Default")
    expect((await run(store.listPolicies(defaultTenantId))).filter((entry) => entry.isDefault)).toHaveLength(1)
  })

  test("seeds the unused default policy from catalog defaults conservatively", async () => {
    const store = await openStore()
    const integrations: TestPolicyCatalog = {
      connections: { list: async () => [connected("mail")] },
      tools: {
        list: async () => [],
        summaries: async () => [
          {
            address: ToolAddress.make("tools.mail.org.primary.sendEmail"),
            name: "sendEmail",
            description: "Send",
            integration: "mail",
            owner: "org",
            connection: "primary",
            defaultDecision: "allow"
          },
          {
            address: ToolAddress.make("tools.mail.org.secondary.sendEmail"),
            name: "sendEmail",
            description: "Send",
            integration: "mail",
            owner: "org",
            connection: "secondary",
            defaultDecision: "require_approval"
          }
        ],
        describe: async () => { throw new Error("not used") },
        execute: async () => ({})
      }
    }
    const policy = await run(ensureDefaultPolicyTools({
      store, integrations, tenantId: defaultTenantId
    }))
    if (policy === undefined) throw new Error("missing default policy")
    const tools = await run(store.listPolicyTools(policy.id))
    expect(tools).toHaveLength(1)
    expect(await run(store.listPolicyIntegrations(policy.id))).toEqual([{
      policyId: policy.id,
      integration: IntegrationSlug.make("mail")
    }])
    expect(tools[0]?.enabled).toBe(true)
    expect(tools[0]?.decision).toBe("require_approval")
  })

  test("adds newly connected safe tools without changing existing decisions", async () => {
    const store = await openStore()
    const policy = await run(store.findDefaultPolicy(defaultTenantId))
    if (policy === undefined) throw new Error("missing default policy")
    await run(store.replacePolicyConfiguration(policy.id, {
      integrations: [IntegrationSlug.make("mail")],
      tools: [{
      integration: IntegrationSlug.make("mail"),
      tool: ToolName.make("search"),
      enabled: true,
      decision: "require_approval"
      }]
    }))
    const integrations: TestPolicyCatalog = {
      connections: { list: async () => [
        connected("mail"),
        connected("context7")
      ] },
      tools: {
        list: async () => [],
        summaries: async () => [
          {
            address: ToolAddress.make("tools.mail.org.primary.search"),
            name: "search",
            description: "Search",
            integration: "mail",
            owner: "org",
            connection: "primary",
            defaultDecision: "allow"
          },
          {
            address: ToolAddress.make("tools.context7.org.default.query-docs"),
            name: "query-docs",
            description: "Query docs",
            integration: "context7",
            owner: "org",
            connection: "default",
            defaultDecision: "allow"
          }
        ],
        describe: async () => { throw new Error("not used") },
        execute: async () => ({})
      }
    }

    await run(ensureDefaultPolicyTools({ store, integrations, tenantId: defaultTenantId }))

    const tools = await run(store.listPolicyTools(policy.id))
    expect(tools).toEqual([
      {
        policyId: policy.id,
        integration: IntegrationSlug.make("context7"),
        tool: ToolName.make("query-docs"),
        enabled: true,
        decision: "allow"
      },
      {
        policyId: policy.id,
        integration: IntegrationSlug.make("mail"),
        tool: ToolName.make("search"),
        enabled: true,
        decision: "require_approval"
      }
    ])
  })

  test("authorizes only the assigned policy and client binding intersection", async () => {
    const store = await openStore()
    const policy = await run(store.createPolicy({
      id: newPolicyId(), tenantId: defaultTenantId, name: "Shared operators"
    }))
    await run(store.replacePolicyConfiguration(policy.id, {
      integrations: [IntegrationSlug.make("mail")],
      tools: [{
      integration: IntegrationSlug.make("mail"),
      tool: ToolName.make("sendEmail"),
      enabled: true,
      decision: "require_approval"
      }]
    }))

    const clients = await Promise.all(["alpha", "beta"].map((name, index) =>
      run(store.createClient({
        id: ClientId.make(`client-${index}`),
        tenantId: defaultTenantId,
        policyId: policy.id,
        name,
        capabilities: []
      }))))
    const first = clients[0]
    if (first === undefined) throw new Error("missing client")
    const binding = await run(store.createBinding({
      id: newClientToolBindingId(),
      tenantId: defaultTenantId,
      clientId: first.id,
      alias: Alias.make("mail"),
      tool: ToolName.make("sendEmail"),
      connection: {
        owner: "org",
        integration: IntegrationSlug.make("mail"),
        name: ConnectionName.make("primary")
      }
    }))
    const key = generateApiKey()
    await run(store.addApiKey({ id: key.id, clientId: first.id, hash: key.hash }))

    const authorization = await run(authorizeInvocation(store, {
      secret: key.secret, alias: binding.alias, tool: binding.tool
    }))
    expect(authorization.status).toBe("authorized")
    if (authorization.status !== "authorized") throw new Error("expected authorization")
    expect(authorization.policy.id).toBe(policy.id)
    expect(authorization.binding.id).toBe(binding.id)
    expect(authorization.decision).toBe("require_approval")

    const denied = await run(authorizeInvocation(store, {
      secret: key.secret, alias: binding.alias, tool: ToolName.make("deleteEmail")
    }))
    expect(denied.status).toBe("not-authorized")
  })

  test("keeps disabled tools explicit and denies them", async () => {
    const store = await openStore()
    const policy = await run(store.createPolicy({
      id: newPolicyId(), tenantId: defaultTenantId, name: "Disabled mail"
    }))
    await run(store.replacePolicyConfiguration(policy.id, {
      integrations: [IntegrationSlug.make("mail")],
      tools: [{
        integration: IntegrationSlug.make("mail"),
        tool: ToolName.make("sendEmail"),
        enabled: false,
        decision: "require_approval"
      }]
    }))
    const client = await run(store.createClient({
      id: ClientId.make("disabled-client"),
      tenantId: defaultTenantId,
      policyId: policy.id,
      name: "Disabled client",
      capabilities: []
    }))
    await run(store.createBinding({
      id: newClientToolBindingId(),
      tenantId: defaultTenantId,
      clientId: client.id,
      alias: Alias.make("mail"),
      tool: ToolName.make("sendEmail"),
      connection: {
        owner: "org",
        integration: IntegrationSlug.make("mail"),
        name: ConnectionName.make("primary")
      }
    }))
    const key = generateApiKey()
    await run(store.addApiKey({ id: key.id, clientId: client.id, hash: key.hash }))

    expect((await run(authorizeInvocation(store, {
      secret: key.secret,
      alias: Alias.make("mail"),
      tool: ToolName.make("sendEmail")
    }))).status).toBe("not-authorized")
    expect(await run(store.listPolicyTools(policy.id))).toEqual([{
      policyId: policy.id,
      integration: IntegrationSlug.make("mail"),
      tool: ToolName.make("sendEmail"),
      enabled: false,
      decision: "require_approval"
    }])
  })

  test("reconciles new tools only beneath explicit custom memberships", async () => {
    const store = await openStore()
    const policy = await run(store.createPolicy({
      id: newPolicyId(), tenantId: defaultTenantId, name: "Mail only"
    }))
    await run(store.replacePolicyConfiguration(policy.id, {
      integrations: [IntegrationSlug.make("mail")],
      tools: [{
        integration: IntegrationSlug.make("mail"),
        tool: ToolName.make("sendEmail"),
        enabled: false,
        decision: "require_approval"
      }]
    }))
    const integrations: TestPolicyCatalog = {
      connections: { list: async () => [
        connected("mail"),
        connected("calendar"),
        connected("empty")
      ] },
      tools: {
        list: async () => [],
        summaries: async () => [{
          address: ToolAddress.make("tools.mail.org.primary.archiveEmail"),
          name: "archiveEmail",
          description: "Archive",
          integration: "mail",
          owner: "org",
          connection: "primary",
          defaultDecision: "allow"
        }, {
          address: ToolAddress.make("tools.calendar.org.primary.createEvent"),
          name: "createEvent",
          description: "Create event",
          integration: "calendar",
          owner: "org",
          connection: "primary",
          defaultDecision: "allow"
        }],
        describe: async () => { throw new Error("not used") },
        execute: async () => ({})
      }
    }

    await run(ensureDefaultPolicyTools({ store, integrations, tenantId: defaultTenantId }))

    const defaultPolicy = await run(store.findDefaultPolicy(defaultTenantId))
    if (defaultPolicy === undefined) throw new Error("missing default policy")
    expect((await run(store.listPolicyIntegrations(defaultPolicy.id))).map((entry) => entry.integration))
      .toContain(IntegrationSlug.make("empty"))

    expect((await run(store.listPolicyIntegrations(policy.id))).map((entry) => entry.integration))
      .toEqual([IntegrationSlug.make("mail")])
    expect(await run(store.listPolicyTools(policy.id))).toEqual([{
      policyId: policy.id,
      integration: IntegrationSlug.make("mail"),
      tool: ToolName.make("archiveEmail"),
      enabled: true,
      decision: "allow"
    }, {
      policyId: policy.id,
      integration: IntegrationSlug.make("mail"),
      tool: ToolName.make("sendEmail"),
      enabled: false,
      decision: "require_approval"
    }])
  })

  test("replaces integrations and tools atomically", async () => {
    const store = await openStore()
    const policy = await run(store.createPolicy({
      id: newPolicyId(), tenantId: defaultTenantId, name: "Atomic"
    }))
    const mail = IntegrationSlug.make("mail")
    await run(store.replacePolicyConfiguration(policy.id, {
      integrations: [mail],
      tools: [{ integration: mail, tool: ToolName.make("sendEmail"), enabled: false, decision: "allow" }]
    }))

    await expect(run(store.replacePolicyConfiguration(policy.id, {
      integrations: [mail, mail],
      tools: []
    }))).rejects.toBeDefined()
    expect((await run(store.listPolicyIntegrations(policy.id))).map((entry) => entry.integration)).toEqual([mail])
    expect((await run(store.listPolicyTools(policy.id)))[0]?.enabled).toBe(false)
  })

  test("rejects assigning a policy across tenant boundaries", async () => {
    const store = await openStore()
    const otherTenant = await run(store.createTenant({ name: "Other" }))
    const defaultPolicy = await run(store.findDefaultPolicy(defaultTenantId))
    const otherPolicy = await run(store.findDefaultPolicy(otherTenant.id))
    if (defaultPolicy === undefined || otherPolicy === undefined) throw new Error("missing default policy")
    const client = await run(store.createClient({
      id: ClientId.make("tenant-client"),
      tenantId: defaultTenantId,
      policyId: defaultPolicy.id,
      name: "Tenant client",
      capabilities: []
    }))
    await expect(run(store.assignPolicy(defaultTenantId, client.id, otherPolicy.id))).rejects.toBeDefined()
    expect((await run(store.findClientById(defaultTenantId, client.id)))?.policyId).toBe(defaultPolicy.id)
  })

  test("migrates each legacy client privately and resolves conflicting decisions conservatively", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "gateway-migration-"))
    directories.push(directory)
    const databasePath = path.join(directory, "gateway.sqlite")
    const database = createSqlClient({ url: `file:${databasePath}` })
    const timestamp = Date.now()
    await database.execute("CREATE TABLE gateway_tenant (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL)")
    await database.execute("INSERT INTO gateway_tenant VALUES ('default', 'Default', ?)", [timestamp])
    await database.execute(`CREATE TABLE gateway_client (
      id TEXT PRIMARY KEY, tenant_id TEXT, name TEXT, capabilities TEXT,
      approval_delivery TEXT, created_at INTEGER, revoked_at INTEGER)`)
    await database.execute(
      "INSERT INTO gateway_client VALUES ('legacy-client', 'default', 'Legacy', '[]', '{\"returnLink\":true,\"webhooks\":[]}', ?, NULL)",
      [timestamp]
    )
    await database.execute(`CREATE TABLE gateway_grant (
      id TEXT PRIMARY KEY, tenant_id TEXT, client_id TEXT, alias TEXT, tool TEXT,
      owner TEXT, subject TEXT, integration TEXT, connection_name TEXT,
      decision TEXT, created_at INTEGER, revoked_at INTEGER)`)
    await database.execute(
      "INSERT INTO gateway_grant VALUES ('binding-1', 'default', 'legacy-client', 'mail', 'sendEmail', 'org', NULL, 'mail', 'primary', 'allow', ?, NULL)",
      [timestamp]
    )
    await database.execute(
      "INSERT INTO gateway_grant VALUES ('binding-2', 'default', 'legacy-client', 'mail-alt', 'sendEmail', 'org', NULL, 'mail', 'secondary', 'require_approval', ?, NULL)",
      [timestamp]
    )
    await database.execute(`CREATE TABLE gateway_pending_approval (
      id TEXT PRIMARY KEY, tenant_id TEXT, client_id TEXT, grant_id TEXT NOT NULL,
      alias TEXT, tool TEXT, arguments TEXT, status TEXT, created_at INTEGER,
      expires_at INTEGER, decided_at INTEGER, decided_by TEXT, result TEXT,
      error TEXT, collected_at INTEGER)`)
    await database.execute(
      "INSERT INTO gateway_pending_approval VALUES ('approval-1', 'default', 'legacy-client', 'binding-1', 'mail', 'sendEmail', '{}', 'pending', ?, ?, NULL, NULL, NULL, NULL, NULL)",
      [timestamp, timestamp + 60_000]
    )
    database.close()

    const store = await run(createGatewayStore(databasePath))
    stores.push(store)
    const client = await run(store.findClientById(defaultTenantId, ClientId.make("legacy-client")))
    expect(client?.policyId).toBe(PolicyId.make("migrated-policy:legacy-client"))
    if (client === undefined) throw new Error("missing migrated client")
    const tools = await run(store.listPolicyTools(client.policyId))
    expect(tools).toHaveLength(1)
    expect(tools[0]?.enabled).toBe(true)
    expect(tools[0]?.decision).toBe("require_approval")
    expect((await run(store.listPolicyIntegrations(client.policyId)))[0]?.integration)
      .toBe(IntegrationSlug.make("mail"))
    expect(await run(store.listBindings(client.id))).toHaveLength(2)
    const migratedApproval = await run(store.getApproval(defaultTenantId, ApprovalId.make("approval-1")))
    expect(migratedApproval?.policyId).toBe(client.policyId)
    expect(migratedApproval?.bindingId).toBe(ClientToolBindingId.make("binding-1"))
    await run(store.createApproval({
      id: ApprovalId.make("approval-2"),
      tenantId: defaultTenantId,
      clientId: client.id,
      policyId: client.policyId,
      bindingId: migratedApproval?.bindingId ?? ClientToolBindingId.make("binding-1"),
      alias: Alias.make("mail"),
      tool: ToolName.make("sendEmail"),
      arguments: {},
      expiresAt: new Date(timestamp + 60_000)
    }))
  })

  test("migrates existing policy tools to enabled rows with memberships idempotently", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "gateway-policy-membership-migration-"))
    directories.push(directory)
    const databasePath = path.join(directory, "gateway.sqlite")
    const database = createSqlClient({ url: `file:${databasePath}` })
    const timestamp = Date.now()
    await database.execute("CREATE TABLE gateway_tenant (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL)")
    await database.execute("INSERT INTO gateway_tenant VALUES ('default', 'Default', ?)", [timestamp])
    await database.execute(`CREATE TABLE gateway_policy (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL,
      is_default INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`)
    await database.execute(
      "INSERT INTO gateway_policy VALUES ('existing-policy', 'default', 'Existing', 0, ?, ?)",
      [timestamp, timestamp]
    )
    await database.execute(`CREATE TABLE gateway_policy_tool (
      policy_id TEXT NOT NULL, integration TEXT NOT NULL, tool TEXT NOT NULL,
      decision TEXT NOT NULL, PRIMARY KEY (policy_id, integration, tool))`)
    await database.execute(
      "INSERT INTO gateway_policy_tool VALUES ('existing-policy', 'mail', 'sendEmail', 'require_approval')"
    )
    database.close()

    const store = await run(createGatewayStore(databasePath))
    stores.push(store)
    const policyId = PolicyId.make("existing-policy")
    expect(await run(store.listPolicyIntegrations(policyId))).toEqual([{
      policyId,
      integration: IntegrationSlug.make("mail")
    }])
    expect((await run(store.listPolicyTools(policyId)))[0]?.enabled).toBe(true)
    await run(store.close())
    stores.pop()
    const reopened = await run(createGatewayStore(databasePath))
    stores.push(reopened)
    expect(await run(reopened.listPolicyIntegrations(policyId))).toHaveLength(1)
  })
})
