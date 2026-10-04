import { describe, expect, it } from "@effect/vitest"
import { TestClock } from "effect/testing"
import { Clock, Effect, Layer, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import path from "node:path"
import { AuditRecord, PendingApproval, PositiveInt } from "@integragents/contracts"
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
  newProfileId,
  newSubjectId,
  SubjectId,
  ToolName
} from "../src/index.ts"
import type { Caller, ConnectionRef, GatewayStore } from "../src/index.ts"
import { generateLoginHandoff } from "../src/keys.ts"
import { openStore, temporaryDirectory, testServices } from "./fixtures.ts"
import { toApproval, toAuditRecord } from "../src/store-rows.ts"

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

const seedProfile = Effect.fnUntraced(function*(
  store: GatewayStore,
  tenantId = defaultTenantId,
  name = `profile-${crypto.randomUUID()}`
) {
  return yield* store.createProfile({
    id: yield* newProfileId,
    tenantId,
    name,
    capabilities: ["provision_connections"],
    tools: [{ connection, tool: ToolName.make("sendEmail"), decision: "require_approval" }]
  })
})

const noCaller: Caller = {
  apiKeyId: null,
  oauthGrantId: null,
  oauthApplicationId: null,
  credentialName: null,
  agent: null
}

/** An expiry the test clock has not reached. */
const notYet = Effect.map(Clock.currentTimeMillis, (now) => new Date(now + 60_000))

describe("gateway store", () => {
  it("reads approved history with its recorded alias", () => {
    const approval = toApproval({
      length: 0,
      id: "approval-1",
      group_id: null,
      profile_id: "profile-1",
      api_key_id: null,
      oauth_grant_id: null,
      oauth_application_id: null,
      credential_name: null,
      agent: null,
      alias: "org_google-5fdrive-5fapi_default",
      tool: "save_file",
      arguments: "{}",
      status: "approved",
      created_at: 1_789_526_960_870,
      expires_at: 1_789_527_020_870,
      decided_at: 1_789_526_970_870,
      decided_by: "operator",
      result: null,
      error: null,
      collected_at: null
    })

    expect(approval.alias).toBe("org_google-5fdrive-5fapi_default")
    expect(Schema.encodeSync(PendingApproval)(approval).alias).toBe(approval.alias)
  })

  it("reads historical audit aliases without changing their recorded value", () => {
    const record = toAuditRecord({
      length: 0,
      id: "audit-1",
      profile_id: null,
      api_key_id: null,
      oauth_grant_id: null,
      oauth_application_id: null,
      credential_name: null,
      agent: null,
      authorized_by_subject_id: null,
      alias: "org_google-5fdrive-5fapi_default",
      tool: "list_files",
      owner: "org",
      subject: null,
      integration: "google_drive_api",
      connection_name: "default",
      decision: "allow",
      outcome: "succeeded",
      message: null,
      created_at: 1_789_526_960_870
    })

    expect(record.alias).toBe("org_google-5fdrive-5fapi_default")
    expect(Schema.encodeSync(AuditRecord)(record).alias).toBe(record.alias)
  })

  it.effect("creating a profile under a taken id changes nothing about the existing one", () =>
    Effect.gen(function*() {
      const gateway = yield* store
      const profile = yield* seedProfile(gateway)
      const before = yield* gateway.listProfileTools(profile.id)

      const result = yield* Effect.result(gateway.createProfile({
        id: profile.id,
        tenantId: defaultTenantId,
        name: "Rollback setup",
        capabilities: [],
        tools: [{ connection, tool: ToolName.make("archiveEmail"), decision: "allow" }]
      }))

      expect(result._tag).toBe("Failure")
      expect(yield* gateway.findProfileById(defaultTenantId, profile.id)).toEqual(profile)
      expect(yield* gateway.listProfileTools(profile.id)).toEqual(before)
      expect(yield* gateway.findProfileByName(defaultTenantId, "Rollback setup")).toBeUndefined()
    }).pipe(Effect.provide(testServices)))

  it.effect("creates the database directory it was pointed at, with no profile in it", () =>
    Effect.gen(function*() {
      const gateway = yield* store
      expect(yield* gateway.listProfiles(defaultTenantId)).toEqual([])
    }).pipe(Effect.provide(testServices)))

  it.effect("persists profiles and their tool decisions", () =>
    Effect.gen(function*() {
      const gateway = yield* store
      const profile = yield* seedProfile(gateway)

      expect(yield* gateway.findProfileById(defaultTenantId, profile.id)).toMatchObject({
        id: profile.id,
        name: profile.name,
        includeNewTools: false,
        revokedAt: null
      })
      expect(yield* gateway.listProfileTools(profile.id)).toEqual([{
        profileId: profile.id,
        connection,
        tool: ToolName.make("sendEmail"),
        decision: "require_approval"
      }])
    }).pipe(Effect.provide(testServices)))

  it.effect("stores only a hash of an API key", () =>
    Effect.gen(function*() {
      const gateway = yield* store
      const profile = yield* seedProfile(gateway)
      const key = yield* generateApiKey
      yield* gateway.addApiKey({ id: key.id, profileId: profile.id, name: "Claude Code", hash: key.hash })

      const stored = yield* gateway.listApiKeys(profile.id)
      expect(stored[0]?.hash).toBe(yield* hashApiKey(key.secret))
      expect(stored[0]?.name).toBe("Claude Code")
      expect(JSON.stringify(stored)).not.toContain(key.secret)
    }).pipe(Effect.provide(testServices)))

  it.effect("updates profile authority and approval delivery together", () =>
    Effect.gen(function*() {
      const gateway = yield* store
      const profile = yield* seedProfile(gateway)
      expect(profile.approvalMethod).toBe("elicitation")

      const updated = yield* gateway.updateProfileSettings(defaultTenantId, profile.id, {
        capabilities: ["administer_gateway"],
        approvalMethod: "none",
        mcpSurface: "discovery",
        approvalGroupWindowMinutes: 15,
        includeNewTools: true
      })

      expect(updated.capabilities).toEqual(["administer_gateway"])
      expect(updated.approvalMethod).toBe("none")
      expect(updated.mcpSurface).toBe("discovery")
      expect(updated.approvalGroupWindowMinutes).toBe(15)
      expect(updated.includeNewTools).toBe(true)
    }).pipe(Effect.provide(testServices)))

  it.effect("creates durable delivery jobs for a profile's destinations", () =>
    Effect.gen(function*() {
      const gateway = yield* store
      const profile = yield* seedProfile(gateway)
      const destination = yield* gateway.createApprovalDestination({
        id: yield* newApprovalDestinationId,
        tenantId: defaultTenantId,
        name: "phone",
        url: "https://notify.example/approvals",
        signingSecret: "igs_secret"
      })
      yield* gateway.replaceProfileApprovalDestinations(
        defaultTenantId,
        profile.id,
        [destination.id]
      )
      const approval = yield* gateway.createApproval({
        id: yield* newApprovalId,
        tenantId: defaultTenantId,
        profileId: profile.id,
        caller: noCaller,
        alias: Alias.make("mail"),
        tool: ToolName.make("sendEmail"),
        arguments: {},
        groupWindowMinutes: 0,
        expiresAt: yield* notYet
      })
      expect(yield* gateway.listApprovalDeliveries(defaultTenantId, "pending")).toMatchObject([{
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
      expect(String(delivered?.body)).toContain(profile.name)
      expect(yield* gateway.listApprovalDeliveries(defaultTenantId)).toMatchObject([{
        status: "delivered",
        attempts: 1
      }])
    }).pipe(Effect.provide(testServices)))

  it.effect("groups calls to one tool within the profile's window and notifies once per group", () =>
    Effect.gen(function*() {
      const gateway = yield* store
      const profile = yield* seedProfile(gateway)
      const destination = yield* gateway.createApprovalDestination({
        id: yield* newApprovalDestinationId,
        tenantId: defaultTenantId,
        name: "phone",
        url: "https://notify.example/approvals",
        signingSecret: "igs_secret"
      })
      yield* gateway.replaceProfileApprovalDestinations(defaultTenantId, profile.id, [destination.id])
      const freeze = Effect.fnUntraced(function*(tool: string, to: string, groupWindowMinutes: number) {
        return yield* gateway.createApproval({
          id: yield* newApprovalId,
          tenantId: defaultTenantId,
          profileId: profile.id,
          caller: noCaller,
          alias: Alias.make("mail"),
          tool: ToolName.make(tool),
          arguments: { to, subject: "Launch" },
          groupWindowMinutes,
          expiresAt: new Date((yield* Clock.currentTimeMillis) + 86_400_000)
        })
      })

      const first = yield* freeze("sendEmail", "a@example.com", 30)
      const second = yield* freeze("sendEmail", "b@example.com", 30)
      const otherTool = yield* freeze("archive", "a@example.com", 30)
      expect(first.groupId).toBe(first.id)
      expect(second.groupId).toBe(first.id)
      expect(otherTool.groupId).toBe(otherTool.id)

      for (const { id } of [first, second]) {
        yield* gateway.settleApproval({ tenantId: defaultTenantId, id, status: "denied", decidedBy: null, result: null, error: null })
      }
      const afterDecided = yield* freeze("sendEmail", "c@example.com", 30)
      expect(afterDecided.groupId).toBe(afterDecided.id)

      yield* TestClock.adjust("31 minutes")
      const afterWindow = yield* freeze("sendEmail", "d@example.com", 30)
      expect(afterWindow.groupId).toBe(afterWindow.id)
      const ungrouped = yield* freeze("sendEmail", "e@example.com", 0)
      expect(ungrouped.groupId).toBe(ungrouped.id)

      const notified = (yield* gateway.listApprovalDeliveries(defaultTenantId)).map((delivery) => delivery.approvalId)
      expect(new Set(notified)).toEqual(new Set([first.id, otherTool.id, afterDecided.id, afterWindow.id, ungrouped.id]))
    }).pipe(Effect.provide(testServices)))

  it.effect("completes and consumes login handoffs and OAuth state once", () =>
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
        expiresAt: yield* notYet
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
        expiresAt: yield* notYet
      })

      expect((yield* gateway.consumeIdentityOAuthState(state.hash))?.returnPath)
        .toBe("/approvals?approval=ap_1")
      expect(yield* gateway.consumeIdentityOAuthState(state.hash)).toBeUndefined()
    }).pipe(Effect.provide(testServices)))

  it.effect("freezes approval arguments and settles them once", () =>
    Effect.gen(function*() {
      const gateway = yield* store
      const profile = yield* seedProfile(gateway)
      const approval = yield* gateway.createApproval({
        id: yield* newApprovalId,
        tenantId: defaultTenantId,
        profileId: profile.id,
        caller: noCaller,
        alias: Alias.make("org___gmail___work"),
        tool: ToolName.make("sendEmail"),
        arguments: { to: ["customer@example.com"], subject: "Follow up" },
        groupWindowMinutes: 0,
        expiresAt: yield* notYet
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

  it.effect("revoking a profile cancels its pending approvals", () =>
    Effect.gen(function*() {
      const gateway = yield* store
      const profile = yield* seedProfile(gateway)
      const approval = yield* gateway.createApproval({
        id: yield* newApprovalId,
        tenantId: defaultTenantId,
        profileId: profile.id,
        caller: noCaller,
        alias: Alias.make("org___gmail___work"),
        tool: ToolName.make("sendEmail"),
        arguments: {},
        groupWindowMinutes: 0,
        expiresAt: yield* notYet
      })

      const cancelled = yield* gateway.cancelApprovalsForProfile(profile.id)

      expect(cancelled).toBe(1)
      const after = yield* gateway.getApproval(defaultTenantId, approval.id)
      expect(after?.status).toBe("denied")
      expect(after?.decidedBy).toBe("profile-revoked")
    }).pipe(Effect.provide(testServices)))

  it.effect("reads back who made a frozen call and an audited one", () =>
    Effect.gen(function*() {
      const gateway = yield* store
      const profile = yield* seedProfile(gateway)
      const key = yield* generateApiKey
      yield* gateway.addApiKey({ id: key.id, profileId: profile.id, name: "Claude Code", hash: key.hash })
      const caller: Caller = {
        apiKeyId: key.id,
        oauthGrantId: null,
        oauthApplicationId: null,
        credentialName: "Claude Code",
        agent: "claude-code/2.1"
      }
      const subject = yield* gateway.createSubject({ id: yield* newSubjectId, tenantId: defaultTenantId })

      const approval = yield* gateway.createApproval({
        id: yield* newApprovalId,
        tenantId: defaultTenantId,
        profileId: profile.id,
        caller,
        alias: Alias.make("org___gmail___work"),
        tool: ToolName.make("sendEmail"),
        arguments: {},
        groupWindowMinutes: 0,
        expiresAt: yield* notYet
      })
      yield* gateway.recordAudit({
        tenantId: defaultTenantId,
        id: yield* newAuditId,
        profileId: profile.id,
        caller,
        authorizedBySubjectId: subject.id,
        alias: Alias.make("org___gmail___work"),
        tool: ToolName.make("sendEmail"),
        connection,
        decision: "require_approval",
        outcome: "pending",
        message: null
      })

      expect((yield* gateway.getApproval(defaultTenantId, approval.id))?.caller).toEqual(caller)
      const [record] = yield* gateway.listAudit(defaultTenantId, { limit: PositiveInt.make(10), profileId: profile.id })
      expect(record?.caller).toEqual(caller)
      expect(record?.profileId).toBe(profile.id)
      expect(record?.authorizedBySubjectId).toBe(subject.id)
    }).pipe(Effect.provide(testServices)))

  it.effect("keeps the audit record after its arguments expire", () =>
    Effect.gen(function*() {
      const gateway = yield* store
      const profile = yield* seedProfile(gateway)
      const now = yield* Clock.currentTimeMillis
      yield* gateway.recordAudit({
        tenantId: defaultTenantId,
        id: yield* newAuditId,
        profileId: profile.id,
        caller: noCaller,
        authorizedBySubjectId: null,
        alias: Alias.make("org___gmail___work"),
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

  it.effect("records a denial that never reached a connection", () =>
    Effect.gen(function*() {
      const gateway = yield* store
      yield* gateway.recordAudit({
        tenantId: defaultTenantId,
        id: yield* newAuditId,
        profileId: null,
        caller: noCaller,
        authorizedBySubjectId: null,
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

  it.effect("upserts tool snapshots so a resync overwrites rather than duplicates", () =>
    Effect.gen(function*() {
      const gateway = yield* store
      const integration = IntegrationSlug.make("gmail")
      const base = {
        integration,
        connection: ConnectionName.make("work"),
        tool: ToolName.make("sendEmail"),
        outputSchema: null,
        syncedAt: new Date(yield* Clock.currentTimeMillis)
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

  it.effect("keeps tenants blind to each other", () =>
    Effect.gen(function*() {
      const gateway = yield* store
      const other = yield* gateway.createTenant({ name: "Acme" })
      const otherSubject = yield* gateway.createSubject({
        id: yield* newSubjectId,
        tenantId: other.id
      })
      expect(otherSubject.tenantId).toBe(other.id)

      const mine = yield* seedProfile(gateway, defaultTenantId, "agent")
      const theirs = yield* seedProfile(gateway, other.id, "agent")
      expect(yield* gateway.listProfiles(defaultTenantId)).toHaveLength(1)
      expect((yield* gateway.findProfileByName(other.id, "agent"))?.id).toBe(theirs.id)

      expect(yield* gateway.findProfileById(other.id, mine.id)).toBeUndefined()
      expect(yield* gateway.revokeProfile(other.id, mine.id)).toBeUndefined()
      expect((yield* gateway.findProfileById(defaultTenantId, mine.id))?.revokedAt).toBeNull()

      const approval = yield* gateway.createApproval({
        id: yield* newApprovalId,
        tenantId: defaultTenantId,
        profileId: mine.id,
        caller: noCaller,
        alias: Alias.make("org___gmail___work"),
        tool: ToolName.make("sendEmail"),
        arguments: {},
        groupWindowMinutes: 0,
        expiresAt: yield* notYet
      })
      expect(yield* gateway.getApproval(other.id, approval.id)).toBeUndefined()
      expect(yield* gateway.listApprovals(other.id)).toEqual([])
      expect(yield* gateway.collectApproval(other.id, approval.id)).toBe(false)

      yield* gateway.recordAudit({
        tenantId: defaultTenantId,
        id: yield* newAuditId,
        profileId: mine.id,
        caller: noCaller,
        authorizedBySubjectId: null,
        alias: null,
        tool: null,
        connection: null,
        decision: null,
        outcome: "succeeded",
        message: null
      })
      expect(yield* gateway.listAudit(other.id, { limit: PositiveInt.make(10) })).toEqual([])
      expect(yield* gateway.countAudit(other.id, {})).toBe(0)
      expect((yield* gateway.overviewCounts(other.id)).profileTools).toBe(1)

      yield* gateway.putToolSnapshots(defaultTenantId, [{
        integration: IntegrationSlug.make("gmail"),
        connection: ConnectionName.make("work"),
        tool: ToolName.make("sendEmail"),
        inputSchema: null,
        outputSchema: null,
        syncedAt: new Date(yield* Clock.currentTimeMillis)
      }])
      expect(yield* gateway.listToolSnapshots(other.id, IntegrationSlug.make("gmail"))).toEqual([])
      expect(yield* gateway.countSubjects(defaultTenantId)).toBe(0)
      expect(yield* gateway.countSubjects(other.id)).toBe(1)
    }).pipe(Effect.provide(testServices)))
})
