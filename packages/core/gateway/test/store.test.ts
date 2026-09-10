import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import path from "node:path"
import { PositiveInt } from "@integrations/contracts"
import {
  Alias,
  ConnectionName,
  deliverDueApprovalNotifications,
  defaultTenantId,
  generateApiKey,
  hashApiKey,
  IntegrationSlug,
  newApprovalId,
  newApprovalDestinationId,
  newAuditId,
  newClientId,
  newAccessProfileId,
  newApprovalPolicyId,
  newSubjectId,
  SubjectId,
  ToolName
} from "../src/index.ts"
import type { ConnectionRef, GatewayStore } from "../src/index.ts"
import { generateLoginHandoff } from "../src/keys.ts"
import { openStore, temporaryDirectory, testServices } from "./fixtures.ts"

/** The nested path proves the store creates the directory it was pointed at. */
const store = Effect.flatMap(
  temporaryDirectory("gateway-store-"),
  (directory) => openStore(path.join(directory, "nested"))
)

const connection: ConnectionRef = {
  owner: "user",
  subject: SubjectId.make("sebastian"),
  integration: IntegrationSlug.make("gmail"),
  name: ConnectionName.make("work")
}

const tenantConfigIds = Effect.fnUntraced(function*(
  store: GatewayStore,
  tenantId = defaultTenantId
) {
  const accessProfile = yield* store.findDefaultAccessProfile(tenantId)
  const approvalPolicy = yield* store.findDefaultApprovalPolicy(tenantId)
  if (accessProfile === undefined || approvalPolicy === undefined) {
    throw new Error(`Missing default configuration for ${tenantId}`)
  }
  return { accessProfileId: accessProfile.id, approvalPolicyId: approvalPolicy.id }
})

const seedBinding = Effect.fnUntraced(function*(store: GatewayStore) {
  const accessProfile = yield* store.createAccessProfile({
    id: yield* newAccessProfileId,
    tenantId: defaultTenantId,
    name: `profile-${crypto.randomUUID()}`
  })
  yield* store.replaceAccessProfileTools(accessProfile.id, [
    { connection, tool: ToolName.make("sendEmail") }
  ])
  const approvalPolicy = yield* store.createApprovalPolicy({
    id: yield* newApprovalPolicyId,
    tenantId: defaultTenantId,
    name: `policy-${crypto.randomUUID()}`
  })
  yield* store.replaceApprovalPolicyTools(approvalPolicy.id, [{
    connection, tool: ToolName.make("sendEmail"), decision: "require_approval"
  }])
  const client = yield* store.createClient({
    id: yield* newClientId,
    tenantId: defaultTenantId,
    accessProfileId: accessProfile.id,
    approvalPolicyId: approvalPolicy.id,
    name: `client-${crypto.randomUUID()}`,
    capabilities: ["provision_connections"]
  })
  return { client, accessProfile, approvalPolicy }
})

/**
 * The store stamps and compares rows against the system clock rather than the
 * Effect one, so these tests run live and date their fixtures the same way.
 */
const notYet = (): Date => new Date(Date.now() + 60_000)

describe("gateway store", () => {
  it.live("client setup rolls back its configurations when the client cannot be inserted", () =>
    Effect.gen(function*() {
      const gateway = yield* store
      const { client } = yield* seedBinding(gateway)
      const accessProfileId = yield* newAccessProfileId
      const approvalPolicyId = yield* newApprovalPolicyId

      const result = yield* Effect.result(gateway.createConfiguredClient({
        id: client.id,
        tenantId: defaultTenantId,
        name: "Rollback setup",
        accessProfileId,
        approvalPolicyId,
        tools: [{ connection, tool: ToolName.make("sendEmail"), decision: "require_approval" }]
      }))

      expect(result._tag).toBe("Failure")
      expect(yield* gateway.findAccessProfile(defaultTenantId, accessProfileId)).toBeUndefined()
      expect(yield* gateway.findApprovalPolicy(defaultTenantId, approvalPolicyId)).toBeUndefined()
      expect(yield* gateway.findClientById(defaultTenantId, client.id)).toEqual(client)
    }).pipe(Effect.provide(testServices)))

  it.live("creates the database directory it was pointed at", () =>
    Effect.gen(function*() {
      const gateway = yield* store
      expect(gateway.databasePath).toContain(path.join("nested", "gateway.sqlite"))
      expect(yield* gateway.listClients(defaultTenantId)).toEqual([])
    }).pipe(Effect.provide(testServices)))

  it.live("persists access profiles and their tools", () =>
    Effect.gen(function*() {
      const gateway = yield* store
      const { accessProfile } = yield* seedBinding(gateway)

      expect(yield* gateway.findAccessProfile(defaultTenantId, accessProfile.id)).toMatchObject({
        id: accessProfile.id,
        name: accessProfile.name
      })
      expect(yield* gateway.listAccessProfileTools(accessProfile.id)).toEqual([{
        accessProfileId: accessProfile.id,
        connection,
        tool: ToolName.make("sendEmail")
      }])
    }).pipe(Effect.provide(testServices)))

  it.live("persists approval policies and their decisions", () =>
    Effect.gen(function*() {
      const gateway = yield* store
      const { approvalPolicy } = yield* seedBinding(gateway)

      expect(yield* gateway.findApprovalPolicy(defaultTenantId, approvalPolicy.id)).toMatchObject({
        id: approvalPolicy.id,
        name: approvalPolicy.name
      })
      expect(yield* gateway.listApprovalPolicyTools(approvalPolicy.id)).toEqual([{
        approvalPolicyId: approvalPolicy.id,
        connection,
        tool: ToolName.make("sendEmail"),
        decision: "require_approval"
      }])
    }).pipe(Effect.provide(testServices)))

  it.live("stores only a hash of an API key", () =>
    Effect.gen(function*() {
      const gateway = yield* store
      const client = yield* gateway.createClient({
        id: yield* newClientId,
        tenantId: defaultTenantId,
        ...yield* tenantConfigIds(gateway),
        name: "hash-check",
        capabilities: ["provision_connections"]
      })
      const key = yield* generateApiKey
      yield* gateway.addApiKey({ id: key.id, clientId: client.id, hash: key.hash })

      const stored = yield* gateway.listApiKeys(client.id)
      expect(stored[0]?.hash).toBe(yield* hashApiKey(key.secret))
      expect(JSON.stringify(stored)).not.toContain(key.secret)
    }).pipe(Effect.provide(testServices)))

  it.live("updates client authority and approval delivery together", () =>
    Effect.gen(function*() {
      const gateway = yield* store
      const client = yield* gateway.createClient({
        id: yield* newClientId,
        tenantId: defaultTenantId,
        ...yield* tenantConfigIds(gateway),
        name: "policy-check",
        capabilities: []
      })
      expect(client.approvalDelivery).toEqual({ returnLink: true })

      const updated = yield* gateway.updateClientSettings({
        tenantId: defaultTenantId,
        id: client.id,
        capabilities: ["provision_connections"],
        approvalDelivery: { returnLink: false }
      })

      expect(updated.capabilities).toEqual(["provision_connections"])
      expect(updated.approvalDelivery).toEqual({ returnLink: false })
    }).pipe(Effect.provide(testServices)))

  it.live("creates durable delivery jobs for a client's destinations", () =>
    Effect.gen(function*() {
      const gateway = yield* store
      const { accessProfile, approvalPolicy, client } = yield* seedBinding(gateway)
      const destination = yield* gateway.createApprovalDestination({
        id: yield* newApprovalDestinationId,
        tenantId: defaultTenantId,
        name: "phone",
        url: "https://notify.example/approvals",
        signingSecret: "wfs_secret"
      })
      yield* gateway.replaceClientApprovalDestinations(
        defaultTenantId,
        client.id,
        [destination.id]
      )
      const approval = yield* gateway.createApproval({
        id: yield* newApprovalId,
        tenantId: defaultTenantId,
        clientId: client.id,
        approvalPolicyId: approvalPolicy.id,
        accessProfileId: accessProfile.id,
        alias: Alias.make("mail"),
        tool: ToolName.make("sendEmail"),
        arguments: {},
        expiresAt: notYet()
      })
      expect(yield* gateway.listApprovalDeliveries(defaultTenantId, approval.id)).toMatchObject([{
        approvalId: approval.id,
        destinationId: destination.id,
        destinationName: "phone",
        status: "pending",
        attempts: 0
      }])

      let delivered: RequestInit | undefined
      const httpClient = FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(
        FetchHttpClient.Fetch,
        Object.assign(async (_url: RequestInfo | URL, init?: RequestInit) => {
          delivered = init
          return new Response(null, { status: 204 })
        }, { preconnect: globalThis.fetch.preconnect })
      )))
      yield* deliverDueApprovalNotifications({
        store: gateway,
        dashboardUrl: "https://gateway.example"
      }).pipe(Effect.provide(httpClient))

      expect(new Headers(delivered?.headers).get("x-integrations-signature")).toMatch(/^v1=/)
      expect(String(delivered?.body)).not.toContain("arguments")
      expect(yield* gateway.listApprovalDeliveries(defaultTenantId, approval.id)).toMatchObject([{
        status: "delivered",
        attempts: 1
      }])
    }).pipe(Effect.provide(testServices)))

  it.live("completes and consumes login handoffs and OAuth state once", () =>
    Effect.gen(function*() {
      const gateway = yield* store
      const tenant = yield* gateway.createTenant({ name: "OAuth workspace" })
      const subject = yield* gateway.createSubject({
        id: yield* newSubjectId,
        tenantId: tenant.id
      })
      yield* gateway.createLogin({
        subjectId: subject.id,
        tenantId: tenant.id,
        email: "oauth@example.com",
        passwordHash: null
      })
      const handoff = yield* generateLoginHandoff
      yield* gateway.createLoginHandoff({
        requestHash: handoff.hash,
        expiresAt: notYet()
      })

      expect(yield* gateway.completeLoginHandoff({
        requestHash: handoff.hash,
        subjectId: subject.id,
        tenantId: tenant.id,
        email: "oauth@example.com"
      })).toBe(true)
      expect(yield* gateway.collectLoginHandoff(handoff.hash)).toBe(true)
      expect(yield* gateway.collectLoginHandoff(handoff.hash)).toBe(false)

      const state = yield* generateLoginHandoff
      yield* gateway.createIdentityOAuthState({
        stateHash: state.hash,
        provider: "google",
        handoffHash: handoff.hash,
        returnPath: "/approvals?approval=ap_1",
        expiresAt: notYet()
      })

      expect((yield* gateway.consumeIdentityOAuthState(state.hash))?.returnPath)
        .toBe("/approvals?approval=ap_1")
      expect(yield* gateway.consumeIdentityOAuthState(state.hash)).toBeUndefined()
    }).pipe(Effect.provide(testServices)))

  it.live("freezes approval arguments and settles them once", () =>
    Effect.gen(function*() {
      const gateway = yield* store
      const { accessProfile, approvalPolicy, client } = yield* seedBinding(gateway)
      const approval = yield* gateway.createApproval({
        id: yield* newApprovalId,
        tenantId: defaultTenantId,
        clientId: client.id,
        approvalPolicyId: approvalPolicy.id,
        accessProfileId: accessProfile.id,
        alias: Alias.make("gmail-work"),
        tool: ToolName.make("sendEmail"),
        arguments: { to: ["customer@example.com"], subject: "Follow up" },
        expiresAt: notYet()
      })
      expect(approval.status).toBe("pending")
      expect(approval.arguments).toEqual({ to: ["customer@example.com"], subject: "Follow up" })

      yield* gateway.claimApproval({
        tenantId: defaultTenantId,
        id: approval.id,
        decidedBy: "sebastian"
      })
      yield* gateway.settleApproval({
        tenantId: defaultTenantId,
        id: approval.id,
        status: "approved",
        decidedBy: "sebastian",
        result: { id: "msg-1" },
        error: null
      })
      yield* gateway.settleApproval({
        tenantId: defaultTenantId,
        id: approval.id,
        status: "denied",
        decidedBy: "someone-else",
        result: null,
        error: null
      })

      const settled = yield* gateway.getApproval(defaultTenantId, approval.id)
      expect(settled?.status).toBe("approved")
      expect(settled?.decidedBy).toBe("sebastian")
      expect(settled?.result).toEqual({ id: "msg-1" })
    }).pipe(Effect.provide(testServices)))

  it.live("revoking a client cancels its pending approvals", () =>
    Effect.gen(function*() {
      const gateway = yield* store
      const { accessProfile, approvalPolicy, client } = yield* seedBinding(gateway)
      const approval = yield* gateway.createApproval({
        id: yield* newApprovalId,
        tenantId: defaultTenantId,
        clientId: client.id,
        approvalPolicyId: approvalPolicy.id,
        accessProfileId: accessProfile.id,
        alias: Alias.make("gmail-work"),
        tool: ToolName.make("sendEmail"),
        arguments: {},
        expiresAt: notYet()
      })

      const cancelled = yield* gateway.cancelApprovalsForClient(client.id)

      expect(cancelled).toBe(1)
      const after = yield* gateway.getApproval(defaultTenantId, approval.id)
      expect(after?.status).toBe("denied")
      expect(after?.decidedBy).toBe("client-revoked")
    }).pipe(Effect.provide(testServices)))

  it.live("keeps the audit record after its arguments expire", () =>
    Effect.gen(function*() {
      const gateway = yield* store
      const { client } = yield* seedBinding(gateway)
      const now = Date.now()
      yield* gateway.recordAudit({
        tenantId: defaultTenantId,
        id: yield* newAuditId,
        clientId: client.id,
        alias: Alias.make("gmail-work"),
        tool: ToolName.make("sendEmail"),
        connection,
        decision: "allow",
        outcome: "succeeded",
        message: null,
        arguments: {
          value: { body: "personal data that should age out" },
          expiresAt: new Date(now - 1_000)
        }
      })

      const removed = yield* gateway.expireAuditArguments(new Date(now))

      expect(removed).toBe(1)
      const records = yield* gateway.listAudit(defaultTenantId, { limit: PositiveInt.make(10) })
      expect(records).toHaveLength(1)
      expect(records[0]?.subject).toBe(SubjectId.make("sebastian"))
      expect(records[0]?.decision).toBe("allow")
      expect(records[0]?.outcome).toBe("succeeded")
    }).pipe(Effect.provide(testServices)))

  it.live("records a denial that never reached a connection", () =>
    Effect.gen(function*() {
      const gateway = yield* store
      yield* gateway.recordAudit({
        tenantId: defaultTenantId,
        id: yield* newAuditId,
        clientId: null,
        alias: null,
        tool: null,
        connection: null,
        decision: null,
        outcome: "denied",
        message: "unknown-key"
      })

      const records = yield* gateway.listAudit(defaultTenantId, { limit: PositiveInt.make(10) })
      expect(records[0]?.outcome).toBe("denied")
      expect(records[0]?.connection).toBeNull()
    }).pipe(Effect.provide(testServices)))

  it.live("upserts tool snapshots so a resync overwrites rather than duplicates", () =>
    Effect.gen(function*() {
      const gateway = yield* store
      const integration = IntegrationSlug.make("gmail")
      const base = {
        integration,
        connection: ConnectionName.make("work"),
        tool: ToolName.make("sendEmail"),
        outputSchema: null,
        syncedAt: new Date()
      }
      yield* gateway.putToolSnapshots(defaultTenantId, [
        { ...base, inputSchema: { type: "object" } }
      ])
      yield* gateway.putToolSnapshots(defaultTenantId, [
        { ...base, inputSchema: { type: "string" } }
      ])

      const snapshots = yield* gateway.listToolSnapshots(defaultTenantId, integration)
      expect(snapshots).toHaveLength(1)
      expect(snapshots[0]?.inputSchema).toEqual({ type: "string" })
    }).pipe(Effect.provide(testServices)))

  it.live("keeps tenants blind to each other", () =>
    Effect.gen(function*() {
      const gateway = yield* store
      const other = yield* gateway.createTenant({ name: "Acme" })
      const otherSubject = yield* gateway.createSubject({
        id: yield* newSubjectId,
        tenantId: other.id
      })
      expect(otherSubject.tenantId).toBe(other.id)

      const mine = yield* gateway.createClient({
        id: yield* newClientId,
        tenantId: defaultTenantId,
        ...yield* tenantConfigIds(gateway),
        name: "agent",
        capabilities: ["provision_connections", "administer_gateway"]
      })
      const theirs = yield* gateway.createClient({
        id: yield* newClientId,
        tenantId: other.id,
        ...yield* tenantConfigIds(gateway, other.id),
        name: "agent",
        capabilities: ["provision_connections", "administer_gateway"]
      })
      expect(yield* gateway.listClients(defaultTenantId)).toHaveLength(1)
      expect((yield* gateway.findClientByName(other.id, "agent"))?.id).toBe(theirs.id)

      expect(yield* gateway.findClientById(other.id, mine.id)).toBeUndefined()
      expect(yield* gateway.revokeClient(other.id, mine.id)).toBeUndefined()
      expect((yield* gateway.findClientById(defaultTenantId, mine.id))?.revokedAt).toBeNull()

      const approval = yield* gateway.createApproval({
        id: yield* newApprovalId,
        tenantId: defaultTenantId,
        clientId: mine.id,
        approvalPolicyId: mine.approvalPolicyId,
        accessProfileId: mine.accessProfileId,
        alias: Alias.make("gmail-work"),
        tool: ToolName.make("sendEmail"),
        arguments: {},
        expiresAt: notYet()
      })
      expect(yield* gateway.getApproval(other.id, approval.id)).toBeUndefined()
      expect(yield* gateway.listApprovals(other.id)).toEqual([])
      expect(yield* gateway.collectApproval(other.id, approval.id)).toBe(false)

      yield* gateway.recordAudit({
        tenantId: defaultTenantId,
        id: yield* newAuditId,
        clientId: mine.id,
        alias: null,
        tool: null,
        connection: null,
        decision: null,
        outcome: "succeeded",
        message: null
      })
      expect(yield* gateway.listAudit(other.id, { limit: PositiveInt.make(10) })).toEqual([])
      expect(yield* gateway.countAudit(other.id, {})).toBe(0)

      yield* gateway.putToolSnapshots(defaultTenantId, [{
        integration: IntegrationSlug.make("gmail"),
        connection: ConnectionName.make("work"),
        tool: ToolName.make("sendEmail"),
        inputSchema: null,
        outputSchema: null,
        syncedAt: new Date()
      }])
      expect(yield* gateway.listToolSnapshots(other.id, IntegrationSlug.make("gmail"))).toEqual([])
      expect(yield* gateway.countSubjects(defaultTenantId)).toBe(0)
      expect(yield* gateway.countSubjects(other.id)).toBe(1)
    }).pipe(Effect.provide(testServices)))
})
