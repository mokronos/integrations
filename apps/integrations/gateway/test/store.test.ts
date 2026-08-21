import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient as openLegacyDatabase } from "@libsql/client"
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
  newGrantId,
  newSubjectId,
  SubjectId,
  ToolName
} from "../src/index.ts"
import type { ConnectionRef, GatewayStore } from "../src/index.ts"

const directories: Array<string> = []
const stores: Array<GatewayStore> = []

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()))
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

const makeStore = async (): Promise<GatewayStore> => {
  const directory = await mkdtemp(path.join(tmpdir(), "wf-gateway-store-"))
  directories.push(directory)
  const store = await createGatewayStore(path.join(directory, "nested", "gateway.sqlite"))
  stores.push(store)
  return store
}

const connection: ConnectionRef = {
  owner: "user",
  subject: SubjectId.make("sebastian"),
  integration: IntegrationSlug.make("gmail"),
  name: ConnectionName.make("work")
}

const seedGrant = async (store: GatewayStore) => {
  const client = await store.createClient({
    id: newClientId(),
    tenantId: defaultTenantId,
    name: `client-${crypto.randomUUID()}`,
    mayMutate: false
  })
  const grant = await store.createGrant({
    id: newGrantId(),
    tenantId: defaultTenantId,
    clientId: client.id,
    alias: Alias.make("gmail-work"),
    tool: ToolName.make("sendEmail"),
    connection,
    decision: "require_approval"
  })
  return { client, grant }
}

describe("gateway store", () => {
  test("creates the database directory it was pointed at", async () => {
    const store = await makeStore()
    expect(store.databasePath).toContain(path.join("nested", "gateway.sqlite"))
    expect(await store.listClients(defaultTenantId)).toEqual([])
  })

  test("round-trips a user-tier connection through the grant", async () => {
    const store = await makeStore()
    const { grant } = await seedGrant(store)

    expect(grant.connection).toEqual(connection)
  })

  test("keeps revoked grants as history while freeing the alias and tool", async () => {
    const store = await makeStore()
    const { client, grant } = await seedGrant(store)

    await store.revokeGrant(defaultTenantId, grant.id)
    // The unique index is partial, so re-granting the same tool is allowed once
    // the previous row is revoked.
    const regranted = await store.createGrant({
      id: newGrantId(),
      tenantId: defaultTenantId,
      clientId: client.id,
      alias: Alias.make("gmail-work"),
      tool: ToolName.make("sendEmail"),
      connection,
      decision: "allow"
    })

    expect(regranted.decision).toBe("allow")
    expect(await store.listGrants(client.id)).toHaveLength(1)
  })

  test("refuses two live grants for the same client, alias, and tool", async () => {
    const store = await makeStore()
    const { client } = await seedGrant(store)

    await expect(store.createGrant({
      id: newGrantId(),
      tenantId: defaultTenantId,
      clientId: client.id,
      alias: Alias.make("gmail-work"),
      tool: ToolName.make("sendEmail"),
      connection,
      decision: "allow"
    })).rejects.toThrow()
  })

  test("stores only a hash of an API key", async () => {
    const store = await makeStore()
    const client = await store.createClient({
      id: newClientId(),
      tenantId: defaultTenantId,
      name: "hash-check",
      mayMutate: false
    })
    const key = generateApiKey()
    await store.addApiKey({ id: key.id, clientId: client.id, hash: key.hash })

    const stored = await store.listApiKeys(client.id)
    expect(stored[0]?.hash).toBe(hashApiKey(key.secret))
    expect(JSON.stringify(stored)).not.toContain(key.secret)
  })

  test("freezes approval arguments and settles them once", async () => {
    const store = await makeStore()
    const { client, grant } = await seedGrant(store)
    const approval = await store.createApproval({
      id: newApprovalId(),
      tenantId: defaultTenantId,
      clientId: client.id,
      grantId: grant.id,
      alias: grant.alias,
      tool: grant.tool,
      arguments: { to: ["customer@example.com"], subject: "Follow up" },
      expiresAt: new Date(Date.now() + 60_000)
    })

    expect(approval.status).toBe("pending")
    expect(approval.arguments).toEqual({ to: ["customer@example.com"], subject: "Follow up" })

    await store.settleApproval({
      tenantId: defaultTenantId,
      id: approval.id,
      status: "approved",
      decidedBy: "sebastian",
      result: { id: "msg-1" },
      error: null
    })
    // A settled approval is final: a second decision must not overwrite it.
    await store.settleApproval({
      tenantId: defaultTenantId,
      id: approval.id,
      status: "denied",
      decidedBy: "someone-else",
      result: null,
      error: null
    })

    const settled = await store.getApproval(defaultTenantId, approval.id)
    expect(settled?.status).toBe("approved")
    expect(settled?.decidedBy).toBe("sebastian")
    expect(settled?.result).toEqual({ id: "msg-1" })
  })

  test("revoking a client cancels its pending approvals", async () => {
    const store = await makeStore()
    const { client, grant } = await seedGrant(store)
    const approval = await store.createApproval({
      id: newApprovalId(),
      tenantId: defaultTenantId,
      clientId: client.id,
      grantId: grant.id,
      alias: grant.alias,
      tool: grant.tool,
      arguments: {},
      expiresAt: new Date(Date.now() + 60_000)
    })

    const cancelled = await store.cancelApprovalsForClient(client.id)

    expect(cancelled).toBe(1)
    const after = await store.getApproval(defaultTenantId, approval.id)
    expect(after?.status).toBe("denied")
    expect(after?.decidedBy).toBe("client-revoked")
  })

  test("keeps the audit record after its arguments expire", async () => {
    const store = await makeStore()
    const { client, grant } = await seedGrant(store)
    const id = newAuditId()
    await store.recordAudit({
      tenantId: defaultTenantId,
      id,
      clientId: client.id,
      alias: grant.alias,
      tool: grant.tool,
      connection,
      decision: "allow",
      outcome: "succeeded",
      message: null,
      arguments: {
        value: { body: "personal data that should age out" },
        expiresAt: new Date(Date.now() - 1_000)
      }
    })

    const removed = await store.expireAuditArguments(new Date())

    expect(removed).toBe(1)
    const records = await store.listAudit(defaultTenantId, { limit: 10 })
    expect(records).toHaveLength(1)
    // The compliance half survives: who acted for whom, and what was decided.
    expect(records[0]?.subject).toBe(SubjectId.make("sebastian"))
    expect(records[0]?.decision).toBe("allow")
    expect(records[0]?.outcome).toBe("succeeded")
  })

  test("records a denial that never reached a connection", async () => {
    const store = await makeStore()
    await store.recordAudit({
      tenantId: defaultTenantId,
      id: newAuditId(),
      clientId: null,
      alias: null,
      tool: null,
      connection: null,
      decision: null,
      outcome: "denied",
      message: "unknown-key"
    })

    const records = await store.listAudit(defaultTenantId, { limit: 10 })
    expect(records[0]?.outcome).toBe("denied")
    expect(records[0]?.connection).toBeNull()
  })

  test("upserts tool snapshots so a resync overwrites rather than duplicates", async () => {
    const store = await makeStore()
    const integration = IntegrationSlug.make("gmail")
    const base = {
      integration,
      connection: ConnectionName.make("work"),
      tool: ToolName.make("sendEmail"),
      outputSchema: null,
      syncedAt: new Date()
    }
    await store.putToolSnapshots(defaultTenantId, [{ ...base, inputSchema: { type: "object" } }])
    await store.putToolSnapshots(defaultTenantId, [{ ...base, inputSchema: { type: "string" } }])

    const snapshots = await store.listToolSnapshots(defaultTenantId, integration)
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]?.inputSchema).toEqual({ type: "string" })
  })

  test("keeps tenants blind to each other", async () => {
    const store = await makeStore()
    const other = await store.createTenant({ name: "Acme" })
    const otherSubject = await store.createSubject({ id: newSubjectId(), tenantId: other.id })
    expect(otherSubject.tenantId).toBe(other.id)

    // The same client name is fine in two partitions...
    const mine = await store.createClient({
      id: newClientId(),
      tenantId: defaultTenantId,
      name: "agent",
      mayMutate: true
    })
    const theirs = await store.createClient({
      id: newClientId(),
      tenantId: other.id,
      name: "agent",
      mayMutate: true
    })
    expect(await store.listClients(defaultTenantId)).toHaveLength(1)
    expect((await store.findClientByName(other.id, "agent"))?.id).toBe(theirs.id)

    // ...but a client of one tenant cannot be reached through the other's.
    expect(await store.findClientById(other.id, mine.id)).toBeUndefined()
    await expect(store.revokeClient(other.id, mine.id)).resolves.toBeUndefined()
    expect((await store.findClientById(defaultTenantId, mine.id))?.revokedAt).toBeNull()

    // Grants, approvals, audit, and snapshots are partitioned the same way.
    const grant = await store.createGrant({
      id: newGrantId(),
      tenantId: defaultTenantId,
      clientId: mine.id,
      alias: Alias.make("gmail-work"),
      tool: ToolName.make("sendEmail"),
      connection,
      decision: "allow"
    })
    const approval = await store.createApproval({
      id: newApprovalId(),
      tenantId: defaultTenantId,
      clientId: mine.id,
      grantId: grant.id,
      alias: grant.alias,
      tool: grant.tool,
      arguments: {},
      expiresAt: new Date(Date.now() + 60_000)
    })
    expect(await store.getApproval(other.id, approval.id)).toBeUndefined()
    expect(await store.listApprovals(other.id)).toEqual([])
    expect(await store.collectApproval(other.id, approval.id)).toBe(false)

    await store.recordAudit({
      tenantId: defaultTenantId,
      id: newAuditId(),
      clientId: mine.id,
      alias: null,
      tool: null,
      connection: null,
      decision: null,
      outcome: "succeeded",
      message: null
    })
    expect(await store.listAudit(other.id, { limit: 10 })).toEqual([])
    expect(await store.countAudit(other.id, {})).toBe(0)

    await store.putToolSnapshots(defaultTenantId, [{
      integration: IntegrationSlug.make("gmail"),
      connection: ConnectionName.make("work"),
      tool: ToolName.make("sendEmail"),
      inputSchema: null,
      outputSchema: null,
      syncedAt: new Date()
    }])
    expect(await store.listToolSnapshots(other.id, IntegrationSlug.make("gmail"))).toEqual([])
    expect(await store.countSubjects(defaultTenantId)).toBe(0)
    expect(await store.countSubjects(other.id)).toBe(1)
  })

  test("migrates a pre-tenancy database into the default tenant", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "wf-gateway-migrate-"))
    directories.push(directory)
    const databasePath = path.join(directory, "gateway.sqlite")

    // Build the old shape by hand: clients with no tenant column.
    const legacy = openLegacyDatabase({ url: `file:${databasePath}` })
    await legacy.execute(`CREATE TABLE gateway_client (
       id TEXT PRIMARY KEY, name TEXT NOT NULL, may_mutate INTEGER NOT NULL,
       created_at INTEGER NOT NULL, revoked_at INTEGER)`)
    await legacy.execute(`CREATE UNIQUE INDEX gateway_client_name ON gateway_client (name)`)
    await legacy.execute(
      "INSERT INTO gateway_client (id, name, may_mutate, created_at, revoked_at) VALUES ('c1', 'legacy', 1, 0, NULL)"
    )
    await legacy.close()

    const store = await createGatewayStore(databasePath)
    stores.push(store)
    const migrated = await store.findClientByName(defaultTenantId, "legacy")
    expect(migrated?.tenantId).toBe(defaultTenantId)
    // The old global name index is gone; per-tenant uniqueness replaced it.
    await expect(store.createClient({
      id: newClientId(),
      tenantId: defaultTenantId,
      name: "legacy",
      mayMutate: false
    })).rejects.toThrow()
    const other = await store.createTenant({ name: "Other" })
    await expect(store.createClient({
      id: newClientId(),
      tenantId: other.id,
      name: "legacy",
      mayMutate: false
    })).resolves.toBeDefined()
  })
})
