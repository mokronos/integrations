import { describe, expect, it } from "@effect/vitest"
import { Clock, Effect } from "effect"
import { TestClock } from "effect/testing"
import { PositiveInt, ToolAddress } from "@integrations/contracts"
import type { Tool } from "@integrations/contracts"
import {
  Alias,
  ConnectionName,
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
import type { ConnectionRef, ToolCatalogReader, ToolSnapshot } from "../src/index.ts"
import { gatewayStore, testServices } from "./fixtures.ts"

const store = gatewayStore("gateway-drift-")

const snapshot = (tool: string, input: ToolSnapshot["inputSchema"]): ToolSnapshot => ({
  integration: IntegrationSlug.make("tickets"),
  connection: ConnectionName.make("default"),
  tool: ToolName.make(tool),
  inputSchema: input,
  outputSchema: null,
  syncedAt: new Date()
})

const integrationsWithTools = (
  tools: ReadonlyArray<{ name: string; input: Tool["inputSchema"] }>
): ToolCatalogReader => ({
  listTools: () =>
    Effect.succeed(tools.map((tool) => ({
      address: ToolAddress.make(`tools.tickets.org.default.${tool.name}`),
      name: ToolName.make(tool.name),
      description: "",
      integration: IntegrationSlug.make("tickets"),
      owner: "org",
      connection: ConnectionName.make("default"),
      defaultDecision: "require_approval",
      inputSchema: tool.input
    })))
})

describe("catalog drift", () => {
  it("reports nothing when a vendor has not moved", () => {
    const before = [snapshot("create", { type: "object" })]
    expect(diffSnapshots(before, before)).toEqual([])
  })

  it("reports a rename as one removal and one addition", () => {
    const entries = diffSnapshots(
      [snapshot("send_email", null)],
      [snapshot("sendEmail", null)]
    )

    expect(entries.map((entry) => `${entry.kind} ${entry.tool}`).sort()).toEqual([
      "added sendEmail",
      "removed send_email"
    ])
  })

  it("reports a reshaped schema under the same name", () => {
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

  it.effect("surfaces new tools, which explicit policies otherwise make invisible", () =>
    Effect.gen(function*() {
      const gateway = yield* store
      const first = yield* refreshIntegrationSnapshot(
        { store: gateway, integrations: integrationsWithTools([{ name: "create", input: null }]) },
        "tickets",
        defaultTenantId
      )
      expect(first.baseline).toBe(true)
      expect(first.entries).toEqual([])

      const second = yield* refreshIntegrationSnapshot(
        {
          store: gateway,
          integrations: integrationsWithTools([
            { name: "create", input: null },
            { name: "deleteEverything", input: null }
          ])
        },
        "tickets",
        defaultTenantId
      )

      expect(second.entries).toEqual([
        {
          kind: "added",
          integration: IntegrationSlug.make("tickets"),
          connection: ConnectionName.make("default"),
          tool: ToolName.make("deleteEverything")
        }
      ])
    }).pipe(Effect.provide(testServices)))

  it.effect("does not report the same removal on every later refresh", () =>
    Effect.gen(function*() {
      const gateway = yield* store
      const refresh = (tools: ReadonlyArray<{ name: string; input: Tool["inputSchema"] }>) =>
        refreshIntegrationSnapshot(
          { store: gateway, integrations: integrationsWithTools(tools) },
          "tickets",
          defaultTenantId
        )
      yield* refresh([{ name: "create", input: null }, { name: "legacy", input: null }])

      const removal = yield* refresh([{ name: "create", input: null }])
      const afterwards = yield* refresh([{ name: "create", input: null }])

      expect(removal.entries.map((entry) => entry.kind)).toEqual(["removed"])
      expect(afterwards.entries).toEqual([])
    }).pipe(Effect.provide(testServices)))
})

describe("gateway maintenance", () => {
  const connection: ConnectionRef = {
    owner: "org",
    integration: IntegrationSlug.make("tickets"),
    name: ConnectionName.make("default")
  }

  it.effect("turns an undecided approval into an expired one", () =>
    Effect.gen(function*() {
      const gateway = yield* store
      const accessProfile = yield* gateway.createAccessProfile({
        id: yield* newAccessProfileId, tenantId: defaultTenantId, name: "sales access"
      })
      const approvalPolicy = yield* gateway.createApprovalPolicy({
        id: yield* newApprovalPolicyId, tenantId: defaultTenantId, name: "sales approvals", tools: []
      })
      const client = yield* gateway.createClient({
        id: yield* newClientId,
        tenantId: defaultTenantId,
        accessProfileId: accessProfile.id,
        approvalPolicyId: approvalPolicy.id,
        name: "sales",
        capabilities: ["provision_connections"]
      })
      const freeze = (tool: string, expiresAt: Date) =>
        Effect.flatMap(newApprovalId, (id) =>
          gateway.createApproval({
            id,
            tenantId: defaultTenantId,
            clientId: client.id,
            accessProfileId: accessProfile.id,
            approvalPolicyId: approvalPolicy.id,
            alias: Alias.make("tickets"),
            tool: ToolName.make(tool),
            arguments: {},
            expiresAt
          }))
      const stale = yield* freeze("create", new Date((yield* Clock.currentTimeMillis) - 1_000))
      const fresh = yield* freeze("close", new Date((yield* Clock.currentTimeMillis) + 60_000))

      const result = yield* runMaintenance(gateway)

      expect(result.expiredApprovals).toBe(1)
      expect((yield* gateway.getApproval(defaultTenantId, stale.id))?.status).toBe("expired")
      expect((yield* gateway.getApproval(defaultTenantId, fresh.id))?.status).toBe("pending")
    }).pipe(Effect.provide(testServices)))

  it.effect("expires an approval once its window passes, not before", () =>
    Effect.gen(function*() {
      const gateway = yield* store
      const accessProfile = yield* gateway.createAccessProfile({
        id: yield* newAccessProfileId, tenantId: defaultTenantId, name: "sales access"
      })
      const approvalPolicy = yield* gateway.createApprovalPolicy({
        id: yield* newApprovalPolicyId, tenantId: defaultTenantId, name: "sales approvals", tools: []
      })
      const client = yield* gateway.createClient({
        id: yield* newClientId,
        tenantId: defaultTenantId,
        accessProfileId: accessProfile.id,
        approvalPolicyId: approvalPolicy.id,
        name: "sales",
        capabilities: ["provision_connections"]
      })
      const frozen = yield* gateway.createApproval({
        id: yield* newApprovalId,
        tenantId: defaultTenantId,
        clientId: client.id,
        accessProfileId: accessProfile.id,
        approvalPolicyId: approvalPolicy.id,
        alias: Alias.make("tickets"),
        tool: ToolName.make("create"),
        arguments: {},
        expiresAt: new Date((yield* Clock.currentTimeMillis) + 60_000)
      })

      expect((yield* runMaintenance(gateway)).expiredApprovals).toBe(0)
      expect((yield* gateway.getApproval(defaultTenantId, frozen.id))?.status).toBe("pending")

      yield* TestClock.adjust("2 minutes")

      expect((yield* runMaintenance(gateway)).expiredApprovals).toBe(1)
      expect((yield* gateway.getApproval(defaultTenantId, frozen.id))?.status).toBe("expired")
    }).pipe(Effect.provide(testServices)))

  it.effect("ages out audit arguments while keeping the record", () =>
    Effect.gen(function*() {
      const gateway = yield* store
      yield* gateway.recordAudit({
        tenantId: defaultTenantId,
        id: yield* newAuditId,
        clientId: null,
        alias: Alias.make("tickets"),
        tool: ToolName.make("create"),
        connection,
        decision: "allow",
        outcome: "succeeded",
        message: null,
        arguments: { value: { body: "PII" }, expiresAt: new Date((yield* Clock.currentTimeMillis) - 1_000) }
      })

      const result = yield* runMaintenance(gateway)

      expect(result.expiredAuditArguments).toBe(1)
      expect(yield* gateway.listAudit(defaultTenantId, { limit: PositiveInt.make(10) }))
        .toHaveLength(1)
    }).pipe(Effect.provide(testServices)))

  it.effect("is safe to run when there is nothing to do", () =>
    Effect.gen(function*() {
      const gateway = yield* store
      expect(yield* runMaintenance(gateway)).toEqual({
        expiredApprovals: 0,
        expiredAuditArguments: 0,
        deletedSessions: 0,
        expiredIdentityFlows: 0
      })
    }).pipe(Effect.provide(testServices)))

  it.effect("deletes abandoned identity and terminal login flows", () =>
    Effect.gen(function*() {
      const gateway = yield* store
      const handoff = yield* generateLoginHandoff
      const state = yield* generateLoginHandoff
      const expiredAt = new Date((yield* Clock.currentTimeMillis) - 1_000)
      yield* gateway.createLoginHandoff({ requestHash: handoff.hash, expiresAt: expiredAt })
      yield* gateway.createIdentityOAuthState({
        stateHash: state.hash,
        provider: "google",
        handoffHash: handoff.hash,
        returnPath: null,
        expiresAt: expiredAt
      })

      expect((yield* runMaintenance(gateway)).expiredIdentityFlows).toBe(2)
      expect(yield* gateway.getLoginHandoff(handoff.hash)).toBeUndefined()
      expect(yield* gateway.consumeIdentityOAuthState(state.hash)).toBeUndefined()
    }).pipe(Effect.provide(testServices)))
})
