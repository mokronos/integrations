import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import {
  Alias,
  aliasForConnection,
  authorizeClientCapability,
  authorizeInvocation,
  ConnectionName,
  defaultTenantId,
  generateApiKey,
  IntegrationSlug,
  newClientId,
  newAccessProfileId,
  newApprovalPolicyId,
  SubjectId,
  ToolName
} from "../src/index.ts"
import type { ConnectionRef, GatewayStore } from "../src/index.ts"
import { gatewayStore, testServices } from "./fixtures.ts"

const orgConnection: ConnectionRef = {
  owner: "org",
  integration: IntegrationSlug.make("sharepoint"),
  name: ConnectionName.make("default")
}

const userConnection: ConnectionRef = {
  owner: "user",
  subject: SubjectId.make("sebastian"),
  integration: IntegrationSlug.make("gmail"),
  name: ConnectionName.make("work")
}

const seed = Effect.fnUntraced(function*(store: GatewayStore, options: {
  readonly capabilities?: ReadonlyArray<"provision_connections" | "administer_gateway">
  readonly connection?: ConnectionRef
  readonly decision?: "allow" | "require_approval"
} = {}) {
  const accessProfile = yield* store.createAccessProfile({
    id: yield* newAccessProfileId,
    tenantId: defaultTenantId,
    name: `access-${crypto.randomUUID()}`
  })
  const approvalPolicy = yield* store.createApprovalPolicy({
    id: yield* newApprovalPolicyId,
    tenantId: defaultTenantId,
    name: `approval-${crypto.randomUUID()}`,
    tools: []
  })
  const client = yield* store.createClient({
    id: yield* newClientId,
    tenantId: defaultTenantId,
    accessProfileId: accessProfile.id,
    approvalPolicyId: approvalPolicy.id,
    name: "support-agent",
    capabilities: options.capabilities ?? ["provision_connections"]
  })
  const key = yield* generateApiKey
  yield* store.addApiKey({ id: key.id, clientId: client.id, hash: key.hash })
  const policyConnection = options.connection ?? orgConnection
  yield* store.replaceAccessProfileTools(accessProfile.id, [{
    connection: policyConnection,
    tool: ToolName.make("getDocument")
  }])
  yield* store.replaceApprovalPolicyTools(approvalPolicy.id, [{
    connection: policyConnection,
    tool: ToolName.make("getDocument"),
    decision: options.decision ?? "allow"
  }])
  return { client, key, accessProfile, approvalPolicy }
})

const invoke = (
  store: GatewayStore,
  secret: string,
  alias = "org_sharepoint_default",
  tool = "getDocument"
) =>
  authorizeInvocation(store, {
    secret,
    alias: Alias.make(alias),
    tool: ToolName.make(tool)
  })

describe("gateway authorization", () => {
  it.effect("authorizes an effective tool and names the connection it resolves to", () =>
    Effect.gen(function*() {
      const store = yield* gatewayStore()
      const { accessProfile, key } = yield* seed(store)

      const result = yield* invoke(store, key.secret)

      expect(result.status).toBe("authorized")
      if (result.status !== "authorized") return
      expect(result.accessProfile.id).toBe(accessProfile.id)
      expect(result.connection).toEqual(orgConnection)
      expect(result.subject).toBeNull()
    }).pipe(Effect.provide(testServices)))

  it.effect("derives the human acted for from the connection, not the key", () =>
    Effect.gen(function*() {
      const store = yield* gatewayStore()
      const { key } = yield* seed(store, { connection: userConnection })

      const result = yield* invoke(store, key.secret, "user_sebastian_gmail_work")

      expect(result.status).toBe("authorized")
      if (result.status !== "authorized") return
      expect(result.subject).toBe(SubjectId.make("sebastian"))
    }).pipe(Effect.provide(testServices)))

  it.effect("carries the policy's approval decision through", () =>
    Effect.gen(function*() {
      const store = yield* gatewayStore()
      const { key } = yield* seed(store, { decision: "require_approval" })

      const result = yield* invoke(store, key.secret)

      expect(result.status).toBe("authorized")
      if (result.status !== "authorized") return
      expect(result.decision).toBe("require_approval")
    }).pipe(Effect.provide(testServices)))

  it.effect("rejects an unknown key", () =>
    Effect.gen(function*() {
      const store = yield* gatewayStore()
      yield* seed(store)

      expect((yield* invoke(store, "wfi_not-a-real-key")).status).toBe("unknown-key")
    }).pipe(Effect.provide(testServices)))

  it.effect("denies every key of a revoked client", () =>
    Effect.gen(function*() {
      const store = yield* gatewayStore()
      const { client, key } = yield* seed(store)
      const second = yield* generateApiKey
      yield* store.addApiKey({ id: second.id, clientId: client.id, hash: second.hash })

      yield* store.revokeClient(defaultTenantId, client.id)

      expect((yield* invoke(store, key.secret)).status).toBe("client-revoked")
      expect((yield* invoke(store, second.secret)).status).toBe("client-revoked")
    }).pipe(Effect.provide(testServices)))

  it.effect("a second live key keeps working while the first is rotated out", () =>
    Effect.gen(function*() {
      const store = yield* gatewayStore()
      const { client, key } = yield* seed(store)
      const replacement = yield* generateApiKey
      yield* store.addApiKey({ id: replacement.id, clientId: client.id, hash: replacement.hash })

      yield* store.revokeApiKey(key.id)

      expect((yield* invoke(store, key.secret)).status).toBe("key-revoked")
      expect((yield* invoke(store, replacement.secret)).status).toBe("authorized")
    }).pipe(Effect.provide(testServices)))

  it.effect("denies a tool outside the intersection, and says no more than it does for an unknown alias", () =>
    Effect.gen(function*() {
      const store = yield* gatewayStore()
      const { key } = yield* seed(store)

      const unauthorizedTool = yield* invoke(store, key.secret, "org_sharepoint_default", "deleteDocument")
      const unknownAlias = yield* invoke(store, key.secret, "nothing-here", "getDocument")

      expect(unauthorizedTool.status).toBe("not-authorized")
      expect(unknownAlias.status).toBe(unauthorizedTool.status)
    }).pipe(Effect.provide(testServices)))

  it.effect("removing a profile route denies it while leaving another route usable", () =>
    Effect.gen(function*() {
      const store = yield* gatewayStore()
      const { accessProfile, approvalPolicy, key } = yield* seed(store)
      yield* store.replaceAccessProfileTools(accessProfile.id, [
        { connection: orgConnection, tool: ToolName.make("getDocument") },
        { connection: userConnection, tool: ToolName.make("search") }
      ])
      yield* store.replaceApprovalPolicyTools(approvalPolicy.id, [
        { connection: orgConnection, tool: ToolName.make("getDocument"), decision: "allow" },
        { connection: userConnection, tool: ToolName.make("search"), decision: "allow" }
      ])

      yield* store.replaceAccessProfileTools(accessProfile.id, [
        { connection: userConnection, tool: ToolName.make("search") }
      ])

      expect((yield* invoke(store, key.secret)).status).toBe("not-authorized")
      expect((yield* invoke(store, key.secret, "user_sebastian_gmail_work", "search")).status)
        .toBe("authorized")
    }).pipe(Effect.provide(testServices)))

  it.effect("two clients hold different policies over the same connection", () =>
    Effect.gen(function*() {
      const store = yield* gatewayStore()
      const { key: readerKey } = yield* seed(store)
      const writerAccess = yield* store.createAccessProfile({
        id: yield* newAccessProfileId, tenantId: defaultTenantId, name: "writer access"
      })
      const writerApproval = yield* store.createApprovalPolicy({
        id: yield* newApprovalPolicyId, tenantId: defaultTenantId, name: "writer approval", tools: []
      })
      const writer = yield* store.createClient({
        id: yield* newClientId,
        tenantId: defaultTenantId,
        accessProfileId: writerAccess.id,
        approvalPolicyId: writerApproval.id,
        name: "sales-campaign",
        capabilities: ["provision_connections"]
      })
      const writerKey = yield* generateApiKey
      yield* store.addApiKey({ id: writerKey.id, clientId: writer.id, hash: writerKey.hash })
      yield* store.replaceAccessProfileTools(writerAccess.id, [{
        connection: orgConnection, tool: ToolName.make("getDocument")
      }])
      yield* store.replaceApprovalPolicyTools(writerApproval.id, [{
        connection: orgConnection, tool: ToolName.make("getDocument"), decision: "require_approval"
      }])

      const reader = yield* invoke(store, readerKey.secret)
      const campaign = yield* invoke(store, writerKey.secret)

      expect(reader.status).toBe("authorized")
      expect(campaign.status).toBe("authorized")
      if (reader.status !== "authorized" || campaign.status !== "authorized") return
      expect(reader.decision).toBe("allow")
      expect(campaign.decision).toBe("require_approval")
    }).pipe(Effect.provide(testServices)))

  it.effect("the tenant's connection and one person's own never share an alias", () =>
    Effect.gen(function*() {
      const store = yield* gatewayStore()
      const { client, key } = yield* seed(store)
      const shared = {
        owner: "org",
        integration: IntegrationSlug.make("gmail"),
        name: ConnectionName.make("work")
      } as const
      expect(aliasForConnection(shared)).not.toBe(aliasForConnection(userConnection))

      const accessProfile = yield* store.findAccessProfile(defaultTenantId, client.accessProfileId)
      const approvalPolicy = yield* store.findApprovalPolicy(defaultTenantId, client.approvalPolicyId)
      if (accessProfile === undefined || approvalPolicy === undefined) {
        throw new Error("missing configuration")
      }
      yield* store.replaceAccessProfileTools(accessProfile.id, [
        { connection: shared, tool: ToolName.make("sendEmail") },
        { connection: userConnection, tool: ToolName.make("sendEmail") }
      ])
      yield* store.replaceApprovalPolicyTools(approvalPolicy.id, [
        { connection: shared, tool: ToolName.make("sendEmail"), decision: "allow" },
        { connection: userConnection, tool: ToolName.make("sendEmail"), decision: "require_approval" }
      ])

      const tenant = yield* invoke(store, key.secret, aliasForConnection(shared), "sendEmail")
      const personal = yield* invoke(store, key.secret, aliasForConnection(userConnection), "sendEmail")

      expect(tenant.status).toBe("authorized")
      expect(personal.status).toBe("authorized")
      if (tenant.status !== "authorized" || personal.status !== "authorized") return
      expect(tenant.connection).toEqual(shared)
      expect(tenant.subject).toBeNull()
      expect(tenant.decision).toBe("allow")
      expect(personal.connection).toEqual(userConnection)
      expect(personal.subject).toBe(SubjectId.make("sebastian"))
      expect(personal.decision).toBe("require_approval")
    }).pipe(Effect.provide(testServices)))

  it.effect("records when a key was last used", () =>
    Effect.gen(function*() {
      const store = yield* gatewayStore()
      const { client, key } = yield* seed(store)
      expect((yield* store.listApiKeys(client.id))[0]?.lastUsedAt).toBeNull()

      yield* invoke(store, key.secret)

      expect((yield* store.listApiKeys(client.id))[0]?.lastUsedAt).not.toBeNull()
    }).pipe(Effect.provide(testServices)))
})

describe("gateway capability authorization", () => {
  it.effect("permits a key whose client holds the requested capability", () =>
    Effect.gen(function*() {
      const store = yield* gatewayStore()
      const { key } = yield* seed(store, {
        capabilities: ["provision_connections", "administer_gateway"]
      })

      expect((yield* authorizeClientCapability(store, key.secret, "administer_gateway")).status)
        .toBe("authorized")
    }).pipe(Effect.provide(testServices)))

  it.effect("refuses a key whose client may not, before any human is asked", () =>
    Effect.gen(function*() {
      const store = yield* gatewayStore()
      const { key } = yield* seed(store, { capabilities: ["provision_connections"] })

      expect((yield* authorizeClientCapability(store, key.secret, "administer_gateway")).status)
        .toBe("not-permitted")
    }).pipe(Effect.provide(testServices)))

  it.effect("refuses unknown and revoked credentials", () =>
    Effect.gen(function*() {
      const store = yield* gatewayStore()
      const { client, key } = yield* seed(store, {
        capabilities: ["provision_connections", "administer_gateway"]
      })

      expect((yield* authorizeClientCapability(store, "wfi_nope", "administer_gateway")).status)
        .toBe("unknown-key")

      yield* store.revokeClient(defaultTenantId, client.id)
      expect((yield* authorizeClientCapability(store, key.secret, "administer_gateway")).status)
        .toBe("client-revoked")
    }).pipe(Effect.provide(testServices)))
})
