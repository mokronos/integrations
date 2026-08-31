import { run, runAll } from "./effect.ts"
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { PositiveInt } from "@mokronos/contracts"
import {
  Alias,
  ConnectionName,
  createGatewayStore,
  defaultTenantId,
  generateApiKey,
  hashApiKey,
  IntegrationSlug,
  newApprovalId,
  newAuditId,
  newClientId,
  newConnectionGrantId,
  newPolicyId,
  newSubjectId,
  SubjectId,
  ToolName
} from "../src/index.ts"
import type { ConnectionRef, GatewayStore } from "../src/index.ts"
import { generateLoginHandoff } from "../src/keys.ts"

const directories: Array<string> = []
const stores: Array<GatewayStore> = []

afterEach(async () => {
  await runAll(stores.splice(0).map((store) => store.close()))
  await run(Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  ))
})

const makeStore = async (): Promise<GatewayStore> => {
  const directory = await run(mkdtemp(path.join(tmpdir(), "wf-gateway-store-")))
  directories.push(directory)
  const store = await run(createGatewayStore(path.join(directory, "nested", "gateway.sqlite")))
  stores.push(store)
  return store
}

const connection: ConnectionRef = {
  owner: "user",
  subject: SubjectId.make("sebastian"),
  integration: IntegrationSlug.make("gmail"),
  name: ConnectionName.make("work")
}

const tenantPolicyId = async (store: GatewayStore, tenantId = defaultTenantId) => {
  const policy = await run(store.findDefaultPolicy(tenantId))
  if (policy === undefined) throw new Error(`Missing default policy for ${tenantId}`)
  return policy.id
}

const seedBinding = async (store: GatewayStore) => {
  const policy = await run(store.createPolicy({
    id: newPolicyId(), tenantId: defaultTenantId, name: `policy-${crypto.randomUUID()}`
  }))
  await run(store.replacePolicyTools(policy.id, [{
      connection,
      tool: ToolName.make("sendEmail"),
      enabled: true,
      decision: "require_approval"
    }]))
  const client = await run(store.createClient({
    id: newClientId(),
    tenantId: defaultTenantId,
    policyId: policy.id,
    name: `client-${crypto.randomUUID()}`,
    capabilities: ["provision_connections"]
  }))
  const grant = await run(store.createGrant({
    id: newConnectionGrantId(),
    tenantId: defaultTenantId,
    clientId: client.id,
    alias: Alias.make("gmail-work"),
    connection,
  }))
  return { client, policy, grant }
}

describe("gateway store", () => {
  test("creates the database directory it was pointed at", async () => {
    const store = await run(makeStore())
    expect(store.databasePath).toContain(path.join("nested", "gateway.sqlite"))
    expect(await run(store.listClients(defaultTenantId))).toEqual([])
  })

  test("round-trips a user-tier connection through the grant", async () => {
    const store = await run(makeStore())
    const { grant } = await run(seedBinding(store))

    expect(grant.connection).toEqual(connection)
  })

  test("keeps revoked grants as history while freeing the alias and tool", async () => {
    const store = await run(makeStore())
    const { client, grant } = await run(seedBinding(store))

    await run(store.revokeGrant(defaultTenantId, grant.id))
    // The unique index is partial, so rebinding the same tool is allowed once
    // the previous row is revoked.
    const regranted = await run(store.createGrant({
      id: newConnectionGrantId(),
      tenantId: defaultTenantId,
      clientId: client.id,
      alias: Alias.make("gmail-work"),
      connection,
    }))

    expect(regranted.connection).toEqual(connection)
    expect(await run(store.listGrants(client.id))).toHaveLength(1)
  })

  test("refuses two live grants for the same client, alias, and tool", async () => {
    const store = await run(makeStore())
    const { client } = await run(seedBinding(store))

    await run(expect(run(store.createGrant({
      id: newConnectionGrantId(),
      tenantId: defaultTenantId,
      clientId: client.id,
      alias: Alias.make("gmail-work"),
      connection,
    }))).rejects.toThrow())
  })

  test("stores only a hash of an API key", async () => {
    const store = await run(makeStore())
    const client = await run(store.createClient({
      id: newClientId(),
      tenantId: defaultTenantId,
      policyId: await tenantPolicyId(store),
      name: "hash-check",
      capabilities: ["provision_connections"]
    }))
    const key = generateApiKey()
    await run(store.addApiKey({ id: key.id, clientId: client.id, hash: key.hash }))

    const stored = await run(store.listApiKeys(client.id))
    expect(stored[0]?.hash).toBe(hashApiKey(key.secret))
    expect(JSON.stringify(stored)).not.toContain(key.secret)
  })

  test("updates client authority and approval delivery together", async () => {
    const store = await run(makeStore())
    const client = await run(store.createClient({
      id: newClientId(),
      tenantId: defaultTenantId,
      policyId: await tenantPolicyId(store),
      name: "policy-check",
      capabilities: []
    }))
    expect(client.approvalDelivery).toEqual({ returnLink: true, webhooks: [] })

    const updated = await run(store.updateClientSettings({
      tenantId: defaultTenantId,
      id: client.id,
      capabilities: ["provision_connections"],
      approvalDelivery: {
        returnLink: false,
        webhooks: ["https://automation.example/approval"]
      }
    }))
    expect(updated.capabilities).toEqual(["provision_connections"])
    expect(updated.approvalDelivery).toEqual({
      returnLink: false,
      webhooks: ["https://automation.example/approval"]
    })
  })

  test("completes and consumes login handoffs and OAuth state once", async () => {
    const store = await run(makeStore())
    const tenant = await run(store.createTenant({ name: "OAuth workspace" }))
    const subject = await run(store.createSubject({ id: newSubjectId(), tenantId: tenant.id }))
    await run(store.createLogin({
      subjectId: subject.id,
      tenantId: tenant.id,
      email: "oauth@example.com",
      passwordHash: null
    }))
    const handoff = generateLoginHandoff()
    await run(store.createLoginHandoff({
      requestHash: handoff.hash,
      expiresAt: new Date(Date.now() + 60_000)
    }))
    expect(await run(store.completeLoginHandoff({
      requestHash: handoff.hash,
      subjectId: subject.id,
      tenantId: tenant.id,
      email: "oauth@example.com"
    }))).toBe(true)
    expect(await run(store.collectLoginHandoff(handoff.hash))).toBe(true)
    expect(await run(store.collectLoginHandoff(handoff.hash))).toBe(false)

    const state = generateLoginHandoff()
    await run(store.createIdentityOAuthState({
      stateHash: state.hash,
      provider: "google",
      handoffHash: handoff.hash,
      returnPath: "/approvals?approval=ap_1",
      expiresAt: new Date(Date.now() + 60_000)
    }))
    expect((await run(store.consumeIdentityOAuthState(state.hash)))?.returnPath).toBe(
      "/approvals?approval=ap_1"
    )
    expect(await run(store.consumeIdentityOAuthState(state.hash))).toBeUndefined()
  })

  test("freezes approval arguments and settles them once", async () => {
    const store = await run(makeStore())
    const { client, policy, grant } = await run(seedBinding(store))
    const approval = await run(store.createApproval({
      id: newApprovalId(),
      tenantId: defaultTenantId,
      clientId: client.id,
      policyId: policy.id,
      grantId: grant.id,
      alias: grant.alias,
      tool: ToolName.make("sendEmail"),
      arguments: { to: ["customer@example.com"], subject: "Follow up" },
      expiresAt: new Date(Date.now() + 60_000)
    }))

    expect(approval.status).toBe("pending")
    expect(approval.arguments).toEqual({ to: ["customer@example.com"], subject: "Follow up" })

    await run(store.settleApproval({
      tenantId: defaultTenantId,
      id: approval.id,
      status: "approved",
      decidedBy: "sebastian",
      result: { id: "msg-1" },
      error: null
    }))
    // A settled approval is final: a second decision must not overwrite it.
    await run(store.settleApproval({
      tenantId: defaultTenantId,
      id: approval.id,
      status: "denied",
      decidedBy: "someone-else",
      result: null,
      error: null
    }))

    const settled = await run(store.getApproval(defaultTenantId, approval.id))
    expect(settled?.status).toBe("approved")
    expect(settled?.decidedBy).toBe("sebastian")
    expect(settled?.result).toEqual({ id: "msg-1" })
  })

  test("revoking a client cancels its pending approvals", async () => {
    const store = await run(makeStore())
    const { client, policy, grant } = await run(seedBinding(store))
    const approval = await run(store.createApproval({
      id: newApprovalId(),
      tenantId: defaultTenantId,
      clientId: client.id,
      policyId: policy.id,
      grantId: grant.id,
      alias: grant.alias,
      tool: ToolName.make("sendEmail"),
      arguments: {},
      expiresAt: new Date(Date.now() + 60_000)
    }))

    const cancelled = await run(store.cancelApprovalsForClient(client.id))

    expect(cancelled).toBe(1)
    const after = await run(store.getApproval(defaultTenantId, approval.id))
    expect(after?.status).toBe("denied")
    expect(after?.decidedBy).toBe("client-revoked")
  })

  test("keeps the audit record after its arguments expire", async () => {
    const store = await run(makeStore())
    const { client, grant } = await run(seedBinding(store))
    const id = newAuditId()
    await run(store.recordAudit({
      tenantId: defaultTenantId,
      id,
      clientId: client.id,
      alias: grant.alias,
      tool: ToolName.make("sendEmail"),
      connection,
      decision: "allow",
      outcome: "succeeded",
      message: null,
      arguments: {
        value: { body: "personal data that should age out" },
        expiresAt: new Date(Date.now() - 1_000)
      }
    }))

    const removed = await run(store.expireAuditArguments(new Date()))

    expect(removed).toBe(1)
    const records = await run(store.listAudit(defaultTenantId, { limit: PositiveInt.make(10) }))
    expect(records).toHaveLength(1)
    // The compliance half survives: who acted for whom, and what was decided.
    expect(records[0]?.subject).toBe(SubjectId.make("sebastian"))
    expect(records[0]?.decision).toBe("allow")
    expect(records[0]?.outcome).toBe("succeeded")
  })

  test("records a denial that never reached a connection", async () => {
    const store = await run(makeStore())
    await run(store.recordAudit({
      tenantId: defaultTenantId,
      id: newAuditId(),
      clientId: null,
      alias: null,
      tool: null,
      connection: null,
      decision: null,
      outcome: "denied",
      message: "unknown-key"
    }))

    const records = await run(store.listAudit(defaultTenantId, { limit: PositiveInt.make(10) }))
    expect(records[0]?.outcome).toBe("denied")
    expect(records[0]?.connection).toBeNull()
  })

  test("upserts tool snapshots so a resync overwrites rather than duplicates", async () => {
    const store = await run(makeStore())
    const integration = IntegrationSlug.make("gmail")
    const base = {
      integration,
      connection: ConnectionName.make("work"),
      tool: ToolName.make("sendEmail"),
      outputSchema: null,
      syncedAt: new Date()
    }
    await run(store.putToolSnapshots(defaultTenantId, [{ ...base, inputSchema: { type: "object" } }]))
    await run(store.putToolSnapshots(defaultTenantId, [{ ...base, inputSchema: { type: "string" } }]))

    const snapshots = await run(store.listToolSnapshots(defaultTenantId, integration))
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]?.inputSchema).toEqual({ type: "string" })
  })

  test("keeps tenants blind to each other", async () => {
    const store = await run(makeStore())
    const other = await run(store.createTenant({ name: "Acme" }))
    const otherSubject = await run(store.createSubject({ id: newSubjectId(), tenantId: other.id }))
    expect(otherSubject.tenantId).toBe(other.id)

    // The same client name is fine in two partitions...
    const mine = await run(store.createClient({
      id: newClientId(),
      tenantId: defaultTenantId,
      policyId: await tenantPolicyId(store),
      name: "agent",
      capabilities: ["provision_connections", "administer_gateway"]
    }))
    const theirs = await run(store.createClient({
      id: newClientId(),
      tenantId: other.id,
      policyId: await tenantPolicyId(store, other.id),
      name: "agent",
      capabilities: ["provision_connections", "administer_gateway"]
    }))
    expect(await run(store.listClients(defaultTenantId))).toHaveLength(1)
    expect((await run(store.findClientByName(other.id, "agent")))?.id).toBe(theirs.id)

    // ...but a client of one tenant cannot be reached through the other's.
    expect(await run(store.findClientById(other.id, mine.id))).toBeUndefined()
    await run(expect(run(store.revokeClient(other.id, mine.id))).resolves.toBeUndefined())
    expect((await run(store.findClientById(defaultTenantId, mine.id)))?.revokedAt).toBeNull()

    // Bindings, approvals, audit, and snapshots are partitioned the same way.
    const grant = await run(store.createGrant({
      id: newConnectionGrantId(),
      tenantId: defaultTenantId,
      clientId: mine.id,
      alias: Alias.make("gmail-work"),
      connection,
    }))
    const approval = await run(store.createApproval({
      id: newApprovalId(),
      tenantId: defaultTenantId,
      clientId: mine.id,
      policyId: mine.policyId,
      grantId: grant.id,
      alias: grant.alias,
      tool: ToolName.make("sendEmail"),
      arguments: {},
      expiresAt: new Date(Date.now() + 60_000)
    }))
    expect(await run(store.getApproval(other.id, approval.id))).toBeUndefined()
    expect(await run(store.listApprovals(other.id))).toEqual([])
    expect(await run(store.collectApproval(other.id, approval.id))).toBe(false)

    await run(store.recordAudit({
      tenantId: defaultTenantId,
      id: newAuditId(),
      clientId: mine.id,
      alias: null,
      tool: null,
      connection: null,
      decision: null,
      outcome: "succeeded",
      message: null
    }))
    expect(await run(store.listAudit(other.id, { limit: PositiveInt.make(10) }))).toEqual([])
    expect(await run(store.countAudit(other.id, {}))).toBe(0)

    await run(store.putToolSnapshots(defaultTenantId, [{
      integration: IntegrationSlug.make("gmail"),
      connection: ConnectionName.make("work"),
      tool: ToolName.make("sendEmail"),
      inputSchema: null,
      outputSchema: null,
      syncedAt: new Date()
    }]))
    expect(await run(store.listToolSnapshots(other.id, IntegrationSlug.make("gmail")))).toEqual([])
    expect(await run(store.countSubjects(defaultTenantId))).toBe(0)
    expect(await run(store.countSubjects(other.id))).toBe(1)
  })

})
