import { run, runAll } from "./effect.ts"
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { PositiveInt, ToolAddress } from "@mokronos/contracts"
import type { Tool } from "@mokronos/contracts"
import {
  Alias,
  ConnectionName,
  createGatewayStore,
  defaultTenantId,
  diffSnapshots,
  generateLoginHandoff,
  IntegrationSlug,
  newAccessProfileId,
  newApprovalId,
  newApprovalPolicyId,
  newAuditId,
  newClientId,
  refreshIntegrationSnapshot,
  runMaintenance,
  ToolName
} from "../src/index.ts"
import type { ConnectionRef, GatewayStore, ToolCatalogReader, ToolSnapshot } from "../src/index.ts"

const directories: Array<string> = []
const stores: Array<GatewayStore> = []

afterEach(async () => {
  await runAll(stores.splice(0).map((store) => store.close()))
  await run(Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  ))
})

const makeStore = async (): Promise<GatewayStore> => {
  const directory = await run(mkdtemp(path.join(tmpdir(), "wf-gateway-drift-")))
  directories.push(directory)
  const store = await run(createGatewayStore(path.join(directory, "gateway.sqlite")))
  stores.push(store)
  return store
}

const snapshot = (tool: string, input: ToolSnapshot["inputSchema"]): ToolSnapshot => ({
  integration: IntegrationSlug.make("tickets"),
  connection: ConnectionName.make("default"),
  tool: ToolName.make(tool),
  inputSchema: input,
  outputSchema: null,
  syncedAt: new Date()
})

/** Stands in for a vendor whose catalog we do not control. Satisfying
 *  `ToolCatalogReader` rather than the whole host surface is what lets this
 *  build a real, fully typed tool list without casting. */
const hostWithTools = (
  tools: ReadonlyArray<{ name: string; input: Tool["inputSchema"] }>
): ToolCatalogReader => ({
  tools: {
    list: async () =>
      tools.map((tool) => ({
        address: ToolAddress.make(`tools.tickets.org.default.${tool.name}`),
        name: tool.name,
        description: "",
        integration: "tickets",
        owner: "org",
        connection: "default",
        defaultDecision: "require_approval",
        inputSchema: tool.input
      }))
  }
})

describe("catalog drift", () => {
  test("reports nothing when a vendor has not moved", () => {
    const before = [snapshot("create", { type: "object" })]
    expect(diffSnapshots(before, before)).toEqual([])
  })

  test("reports a rename as one removal and one addition", () => {
    const entries = diffSnapshots(
      [snapshot("send_email", null)],
      [snapshot("sendEmail", null)]
    )

    expect(entries.map((entry) => `${entry.kind} ${entry.tool}`).sort()).toEqual([
      "added sendEmail",
      "removed send_email"
    ])
  })

  test("reports a reshaped schema under the same name", () => {
    const entries = diffSnapshots(
      [snapshot("create", { type: "object" })],
      [snapshot("create", { type: "string" })]
    )

    expect(entries).toEqual([
      {
        kind: "changed",
        integration: IntegrationSlug.make("tickets"),
        connection: ConnectionName.make("default"),
        tool: ToolName.make("create")
      }
    ])
  })

  test("surfaces new tools, which explicit policies otherwise make invisible", async () => {
    const store = await run(makeStore())
    // The first sync has nothing to compare against, so it records the shape
    // and reports a baseline. Calling an integration's entire surface "added"
    // would bury the one real change in the run that matters.
    const first = await run(refreshIntegrationSnapshot(
      { store, integrations: hostWithTools([{ name: "create", input: null }]) },
      "tickets",
      defaultTenantId
    ))
    expect(first.baseline).toBe(true)
    expect(first.entries).toEqual([])

    const second = await run(refreshIntegrationSnapshot(
      {
        store,
        integrations: hostWithTools([
          { name: "create", input: null },
          { name: "deleteEverything", input: null }
        ])
      },
      "tickets",
      defaultTenantId
    ))

    // Unreachable until the access profile allows it, which is why it has to be
    // reported rather than left to be noticed.
    expect(second.entries).toEqual([
      {
        kind: "added",
        integration: IntegrationSlug.make("tickets"),
        connection: ConnectionName.make("default"),
        tool: ToolName.make("deleteEverything")
      }
    ])
  })

  test("does not report the same removal on every later refresh", async () => {
    const store = await run(makeStore())
    await run(refreshIntegrationSnapshot(
      {
        store,
        integrations: hostWithTools([
          { name: "create", input: null },
          { name: "legacy", input: null }
        ])
      },
      "tickets",
      defaultTenantId
    ))

    const removal = await run(refreshIntegrationSnapshot(
      { store, integrations: hostWithTools([{ name: "create", input: null }]) },
      "tickets",
      defaultTenantId
    ))
    const afterwards = await run(refreshIntegrationSnapshot(
      { store, integrations: hostWithTools([{ name: "create", input: null }]) },
      "tickets",
      defaultTenantId
    ))

    expect(removal.entries.map((entry) => entry.kind)).toEqual(["removed"])
    expect(afterwards.entries).toEqual([])
  })
})

describe("gateway maintenance", () => {
  const connection: ConnectionRef = {
    owner: "org",
    integration: IntegrationSlug.make("tickets"),
    name: ConnectionName.make("default")
  }

  test("turns an undecided approval into an expired one", async () => {
    const store = await run(makeStore())
    const accessProfile = await run(store.createAccessProfile({
      id: newAccessProfileId(), tenantId: defaultTenantId, name: "sales access"
    }))
    const approvalPolicy = await run(store.createApprovalPolicy({
      id: newApprovalPolicyId(), tenantId: defaultTenantId, name: "sales approvals"
    }))
    const client = await run(store.createClient({
      id: newClientId(),
      tenantId: defaultTenantId,
      accessProfileId: accessProfile.id,
      approvalPolicyId: approvalPolicy.id,
      name: "sales",
      capabilities: ["provision_connections"]
    }))
    const stale = await run(store.createApproval({
      id: newApprovalId(),
      tenantId: defaultTenantId,
      clientId: client.id,
      accessProfileId: accessProfile.id,
      approvalPolicyId: approvalPolicy.id,
      alias: Alias.make("tickets"),
      tool: ToolName.make("create"),
      arguments: {},
      expiresAt: new Date(Date.now() - 1_000)
    }))
    const fresh = await run(store.createApproval({
      id: newApprovalId(),
      tenantId: defaultTenantId,
      clientId: client.id,
      accessProfileId: accessProfile.id,
      approvalPolicyId: approvalPolicy.id,
      alias: Alias.make("tickets"),
      tool: ToolName.make("close"),
      arguments: {},
      expiresAt: new Date(Date.now() + 60_000)
    }))

    const result = await run(runMaintenance(store))

    expect(result.expiredApprovals).toBe(1)
    // Expiry is a decision: the invocation does not happen.
    expect((await run(store.getApproval(defaultTenantId, stale.id)))?.status).toBe("expired")
    expect((await run(store.getApproval(defaultTenantId, fresh.id)))?.status).toBe("pending")
  })

  test("ages out audit arguments while keeping the record", async () => {
    const store = await run(makeStore())
    const id = newAuditId()
    await run(store.recordAudit({
      tenantId: defaultTenantId,
      id,
      clientId: null,
      alias: Alias.make("tickets"),
      tool: ToolName.make("create"),
      connection,
      decision: "allow",
      outcome: "succeeded",
      message: null,
      arguments: { value: { body: "PII" }, expiresAt: new Date(Date.now() - 1_000) }
    }))

    const result = await run(runMaintenance(store))

    expect(result.expiredAuditArguments).toBe(1)
    expect(await run(store.listAudit(defaultTenantId, { limit: PositiveInt.make(10) }))).toHaveLength(1)
  })

  test("is safe to run when there is nothing to do", async () => {
    const store = await run(makeStore())
    expect(await run(runMaintenance(store))).toEqual({
      expiredApprovals: 0,
      expiredAuditArguments: 0,
      deletedSessions: 0,
      expiredIdentityFlows: 0
    })
  })

  test("deletes abandoned identity and terminal login flows", async () => {
    const store = await run(makeStore())
    const handoff = generateLoginHandoff()
    const state = generateLoginHandoff()
    const expiredAt = new Date(Date.now() - 1_000)
    await run(store.createLoginHandoff({ requestHash: handoff.hash, expiresAt: expiredAt }))
    await run(store.createIdentityOAuthState({
      stateHash: state.hash,
      provider: "google",
      handoffHash: handoff.hash,
      returnPath: null,
      expiresAt: expiredAt
    }))

    expect((await run(runMaintenance(store))).expiredIdentityFlows).toBe(2)
    expect(await run(store.getLoginHandoff(handoff.hash))).toBeUndefined()
    expect(await run(store.consumeIdentityOAuthState(state.hash))).toBeUndefined()
  })
})
