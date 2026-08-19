import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  Alias,
  ConnectionName,
  createGatewayStore,
  generateApiKey,
  hashApiKey,
  IntegrationSlug,
  newApprovalId,
  newAuditId,
  newClientId,
  newGrantId,
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
    name: `client-${crypto.randomUUID()}`,
    mayMutate: false
  })
  const grant = await store.createGrant({
    id: newGrantId(),
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
    expect(await store.listClients()).toEqual([])
  })

  test("round-trips a user-tier connection through the grant", async () => {
    const store = await makeStore()
    const { grant } = await seedGrant(store)

    expect(grant.connection).toEqual(connection)
  })

  test("keeps revoked grants as history while freeing the alias and tool", async () => {
    const store = await makeStore()
    const { client, grant } = await seedGrant(store)

    await store.revokeGrant(grant.id)
    // The unique index is partial, so re-granting the same tool is allowed once
    // the previous row is revoked.
    const regranted = await store.createGrant({
      id: newGrantId(),
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
      id: approval.id,
      status: "approved",
      decidedBy: "sebastian",
      result: { id: "msg-1" },
      error: null
    })
    // A settled approval is final: a second decision must not overwrite it.
    await store.settleApproval({
      id: approval.id,
      status: "denied",
      decidedBy: "someone-else",
      result: null,
      error: null
    })

    const settled = await store.getApproval(approval.id)
    expect(settled?.status).toBe("approved")
    expect(settled?.decidedBy).toBe("sebastian")
    expect(settled?.result).toEqual({ id: "msg-1" })
  })

  test("revoking a client cancels its pending approvals", async () => {
    const store = await makeStore()
    const { client, grant } = await seedGrant(store)
    const approval = await store.createApproval({
      id: newApprovalId(),
      clientId: client.id,
      grantId: grant.id,
      alias: grant.alias,
      tool: grant.tool,
      arguments: {},
      expiresAt: new Date(Date.now() + 60_000)
    })

    const cancelled = await store.cancelApprovalsForClient(client.id)

    expect(cancelled).toBe(1)
    const after = await store.getApproval(approval.id)
    expect(after?.status).toBe("denied")
    expect(after?.decidedBy).toBe("client-revoked")
  })

  test("keeps the audit record after its arguments expire", async () => {
    const store = await makeStore()
    const { client, grant } = await seedGrant(store)
    const id = newAuditId()
    await store.recordAudit({
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
    const records = await store.listAudit({ limit: 10 })
    expect(records).toHaveLength(1)
    // The compliance half survives: who acted for whom, and what was decided.
    expect(records[0]?.subject).toBe(SubjectId.make("sebastian"))
    expect(records[0]?.decision).toBe("allow")
    expect(records[0]?.outcome).toBe("succeeded")
  })

  test("records a denial that never reached a connection", async () => {
    const store = await makeStore()
    await store.recordAudit({
      id: newAuditId(),
      clientId: null,
      alias: null,
      tool: null,
      connection: null,
      decision: null,
      outcome: "denied",
      message: "unknown-key"
    })

    const records = await store.listAudit({ limit: 10 })
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
    await store.putToolSnapshots([{ ...base, inputSchema: { type: "object" } }])
    await store.putToolSnapshots([{ ...base, inputSchema: { type: "string" } }])

    const snapshots = await store.listToolSnapshots(integration)
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]?.inputSchema).toEqual({ type: "string" })
  })
})
