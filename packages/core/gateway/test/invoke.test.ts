import { describe, expect, it } from "@effect/vitest"
import { Clock, Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { whenPresent } from "@integragents/contracts"
import {
  HostTools,
  Integrations,
  McpClient,
  OpenApiInvoker,
  stubbedLayer,
  unavailableHttpClientLayer
} from "@integragents/host"
import type { HostIntegrationDefinition, HostToolInvocation } from "@integragents/host"
import {
  aliasForConnection,
  approveApproval,
  ConnectionName,
  decideWaitingApproval,
  denyApproval,
  defaultTenantId,
  IntegrationSlug,
  invokeAsProfile,
  newProfileId,
  notifyingDecisions,
  registerHostIntegration,
  SubjectId,
  ToolName,
  unattributedOrigin
} from "../src/index.ts"
import type {
  ApprovalDecided,
  ConnectionRef,
  CreateProfileInput,
  GatewayStore,
  Profile,
  ToolDecision
} from "../src/index.ts"
import { gatewayStore, testServices } from "./fixtures.ts"

type Json = typeof import("effect").Schema.Json.Type

const sandbox = IntegrationSlug.make("sandbox")
const runCommand = ToolName.make("run_command")
const sandboxConnection: ConnectionRef = { owner: "org", integration: sandbox, name: ConnectionName.make("default") }
const alias = aliasForConnection(sandboxConnection)
const alice = SubjectId.make("alice")
const bob = SubjectId.make("bob")

const definition: HostIntegrationDefinition = {
  slug: sandbox,
  name: "Sandbox",
  tools: [
    {
      name: runCommand,
      description: "Run a shell command in the user's VM",
      inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] }
    }
  ]
}

const unusedMcp = Layer.succeed(McpClient, {
  probe: () => Effect.die("unused"),
  listTools: () => Effect.die("unused"),
  callTool: () => Effect.die("unused")
})

/** The real integration host with a sandbox integration whose commands land in `seen`. */
const hostLayer = (seen: Array<HostToolInvocation>) =>
  Layer.mergeAll(
    stubbedLayer(Layer.mergeAll(unusedMcp, OpenApiInvoker.unavailableTestLayer)).pipe(
      Layer.provide(
        HostTools.layer({
          execute: (invocation) =>
            Effect.sync((): Json => {
              seen.push(invocation)
              return { exitCode: 0, ran: invocation.arguments }
            })
        })
      )
    ),
    unavailableHttpClientLayer,
    testServices
  )

const harness = Effect.fnUntraced(function* (
  options: { readonly decision?: ToolDecision; readonly profile?: Partial<CreateProfileInput> } = {}
) {
  const decided: Array<ApprovalDecided> = []
  const store = notifyingDecisions(yield* gatewayStore("gateway-invoke-"), (event) =>
    Effect.sync(() => {
      decided.push(event)
    })
  )
  const integrations = yield* Integrations
  yield* integrations.registerHostIntegration(definition)
  const profile = yield* store.createProfile({
    id: yield* newProfileId,
    tenantId: defaultTenantId,
    name: "vm-agent",
    capabilities: [],
    tools: [{ connection: sandboxConnection, tool: runCommand, decision: options.decision ?? "allow" }],
    ...options.profile
  })
  const dependencies = { store, integrations, retentionDays: 30 }
  const invoke = (command: string, extra: { readonly subject?: typeof alice; readonly profile?: Profile } = {}) =>
    invokeAsProfile(dependencies, {
      profile: extra.profile ?? profile,
      origin: unattributedOrigin,
      alias,
      tool: runCommand,
      arguments: { command },
      ...whenPresent("subject", extra.subject)
    })
  return { store, integrations, profile, dependencies, invoke, decided }
})

/** Records written in the same millisecond have no order between them, so only what was recorded is compared. */
const auditOf = (store: GatewayStore) =>
  Effect.map(store.listAudit(defaultTenantId, {}), (records) =>
    records.map((record) => [record.outcome, record.approval, record.message]).toSorted()
  )

describe("host tools through the gateway", () => {
  it.effect("an approved host tool runs after the decision, told who it acts for and under which approval", () => {
    const seen: Array<HostToolInvocation> = []
    return Effect.gen(function* () {
      const { store, profile, dependencies, invoke } = yield* harness({ decision: "require_approval" })

      const pending = yield* invoke("rm -rf build", { subject: alice })
      if (pending.status !== "pending") return yield* Effect.die(`expected pending, got ${pending.status}`)
      expect(seen).toEqual([])

      const { outcome } = yield* approveApproval(dependencies, {
        tenantId: defaultTenantId,
        id: pending.approvalId,
        decidedBy: "operator@example.com"
      })

      expect(outcome).toEqual({ status: "succeeded", result: { exitCode: 0, ran: { command: "rm -rf build" } } })
      expect(seen.map((call) => [call.handler, call.context])).toEqual([
        [
          "run_command",
          { tenantId: defaultTenantId, profileId: profile.id, subject: alice, approvalId: pending.approvalId }
        ]
      ])
      expect(yield* auditOf(store)).toEqual(
        [
          ["pending", null, `approval ${pending.approvalId}`],
          ["succeeded", "approved", "approved by operator@example.com"]
        ].toSorted()
      )
    }).pipe(Effect.provide(hostLayer(seen)))
  })

  it.effect(
    "a host integration joins the profiles that take new tools when it is first registered, not on restart",
    () => {
      const seen: Array<HostToolInvocation> = []
      return Effect.gen(function* () {
        const store = yield* gatewayStore("gateway-invoke-")
        const integrations = yield* Integrations
        const create = (name: string, includeNewTools: boolean) =>
          Effect.flatMap(newProfileId, (id) =>
            store.createProfile({ id, tenantId: defaultTenantId, name, capabilities: [], includeNewTools, tools: [] })
          )
        const taking = yield* create("taking", true)
        const keeping = yield* create("keeping", false)
        const withReader = {
          ...definition,
          tools: [...definition.tools, { name: ToolName.make("read_file"), description: "Read a file", readOnly: true }]
        }
        const enabled = (profile: Profile) =>
          Effect.map(store.listProfileTools(profile.id), (tools) => tools.map((tool) => [tool.tool, tool.decision]))

        yield* registerHostIntegration({ store, integrations, definition: withReader })
        const afterFirst = { taking: yield* enabled(taking), keeping: yield* enabled(keeping) }
        yield* store.replaceProfileTools(taking.id, [])
        yield* registerHostIntegration({ store, integrations, definition: withReader })

        expect(afterFirst).toEqual({
          taking: [
            ["read_file", "allow"],
            ["run_command", "require_approval"]
          ],
          keeping: []
        })
        expect(yield* enabled(taking)).toEqual([])
      }).pipe(Effect.provide(hostLayer(seen)))
    }
  )

  it.effect("the same command for two people waits for two decisions", () => {
    const seen: Array<HostToolInvocation> = []
    return Effect.gen(function* () {
      const { invoke } = yield* harness({ decision: "require_approval" })

      const forAlice = yield* invoke("reboot", { subject: alice })
      const forBob = yield* invoke("reboot", { subject: bob })
      const aliceAgain = yield* invoke("reboot", { subject: alice })

      const ids = [forAlice, forBob, aliceAgain].map((outcome) =>
        outcome.status === "pending" ? outcome.approvalId : outcome.status
      )
      expect(ids[0]).not.toEqual(ids[1])
      expect(ids[2]).toEqual(ids[0])
    }).pipe(Effect.provide(hostLayer(seen)))
  })
})

describe("what a profile may do", () => {
  it.effect("acts only for the subjects the profile names, and records the refusal", () => {
    const seen: Array<HostToolInvocation> = []
    return Effect.gen(function* () {
      const { store, invoke } = yield* harness({ profile: { subjects: [alice] } })

      const forBob = yield* invoke("whoami", { subject: bob })
      const forAlice = yield* invoke("whoami", { subject: alice })
      const forNobody = yield* invoke("whoami")

      expect([forBob.status, forAlice.status, forNobody.status]).toEqual(["denied", "succeeded", "succeeded"])
      expect(forBob.status === "denied" ? forBob.reason : "").toContain("bob")
      expect(seen.map((call) => call.context.subject)).toEqual([alice, undefined])
      expect((yield* auditOf(store)).filter(([outcome]) => outcome === "denied")).toEqual([
        ["denied", null, expect.stringContaining("bob")]
      ])
    }).pipe(Effect.provide(hostLayer(seen)))
  })

  it.effect("acts for anyone unless the profile says otherwise, and the setting can change", () => {
    const seen: Array<HostToolInvocation> = []
    return Effect.gen(function* () {
      const { store, profile, invoke } = yield* harness()
      expect(profile.subjects).toBe("any")

      const updated = yield* store.updateProfileSettings(defaultTenantId, profile.id, {
        capabilities: profile.capabilities,
        approvalMethod: profile.approvalMethod,
        mcpSurface: profile.mcpSurface,
        approvalGroupWindowMinutes: profile.approvalGroupWindowMinutes,
        includeNewTools: profile.includeNewTools,
        approvalExpiryMinutes: profile.approvalExpiryMinutes,
        subjects: [bob]
      })

      expect(updated.subjects).toEqual([bob])
      expect((yield* invoke("whoami", { subject: alice, profile: updated })).status).toBe("denied")
    }).pipe(Effect.provide(hostLayer(seen)))
  })

  it.effect("holds a call as long as its profile says, or until someone decides", () => {
    const seen: Array<HostToolInvocation> = []
    return Effect.gen(function* () {
      const brief = yield* harness({ decision: "require_approval", profile: { approvalExpiryMinutes: 5 } })
      const patient = yield* harness({ decision: "require_approval", profile: { approvalExpiryMinutes: null } })
      expect(brief.profile.approvalExpiryMinutes).toBe(5)
      expect(patient.profile.approvalExpiryMinutes).toBeNull()

      const before = yield* Clock.currentTimeMillis
      const short = yield* brief.invoke("deploy")
      const forever = yield* patient.invoke("deploy")
      if (short.status !== "pending" || forever.status !== "pending") return yield* Effect.die("expected pending")

      expect((short.expiresAt?.getTime() ?? 0) - before).toBeGreaterThanOrEqual(5 * 60_000 - 1_000)
      expect((short.expiresAt?.getTime() ?? 0) - before).toBeLessThanOrEqual(5 * 60_000 + 1_000)
      expect(forever.expiresAt).toBeNull()

      const yearsLater = new Date(before + 10 * 365 * 24 * 60 * 60_000)
      yield* brief.store.expireApprovals(yearsLater)
      yield* patient.store.expireApprovals(yearsLater)
      expect((yield* brief.store.getApproval(defaultTenantId, short.approvalId))?.status).toBe("expired")
      const waiting = yield* patient.store.getApproval(defaultTenantId, forever.approvalId)
      expect([waiting?.status, waiting?.expiresAt]).toEqual(["pending", null])

      const { outcome } = yield* approveApproval(patient.dependencies, {
        tenantId: defaultTenantId,
        id: forever.approvalId,
        decidedBy: "operator"
      })
      expect(outcome.status).toBe("succeeded")
    }).pipe(Effect.provide(hostLayer(seen)))
  })
})

describe("telling the host a call was decided", () => {
  const summary = (decided: ReadonlyArray<ApprovalDecided>) =>
    decided.map((event) => [event.status, event.decidedBy, event.outcome])

  it.effect("on approval, with the result, and on denial, with who denied it", () => {
    const seen: Array<HostToolInvocation> = []
    return Effect.gen(function* () {
      const { profile, dependencies, invoke, decided, store } = yield* harness({ decision: "require_approval" })
      const first = yield* invoke("make")
      const second = yield* invoke("make clean")
      if (first.status !== "pending" || second.status !== "pending") return yield* Effect.die("expected pending")

      yield* approveApproval(dependencies, { tenantId: defaultTenantId, id: first.approvalId, decidedBy: "ann" })
      yield* denyApproval(store, { tenantId: defaultTenantId, id: second.approvalId, decidedBy: "ben" })

      expect(summary(decided)).toEqual([
        ["approved", "ann", { status: "succeeded", result: { exitCode: 0, ran: { command: "make" } } }],
        ["denied", "ben", { status: "denied", reason: `approval ${second.approvalId} was denied by ben` }]
      ])
      expect(decided.map((event) => [event.tenantId, event.profileId, event.approvalId])).toEqual([
        [defaultTenantId, profile.id, first.approvalId],
        [defaultTenantId, profile.id, second.approvalId]
      ])
    }).pipe(Effect.provide(hostLayer(seen)))
  })

  it.effect("when a call expires, whether a sweep or a late decision finds it", () => {
    const seen: Array<HostToolInvocation> = []
    return Effect.gen(function* () {
      const { dependencies, invoke, decided, store } = yield* harness({
        decision: "require_approval",
        profile: { approvalExpiryMinutes: 1 }
      })
      const swept = yield* invoke("sleep 1")
      yield* TestClock.adjust("30 seconds")
      const late = yield* invoke("sleep 2")
      if (swept.status !== "pending" || late.status !== "pending") return yield* Effect.die("expected pending")

      yield* store.expireApprovals(swept.expiresAt ?? new Date())
      yield* TestClock.adjust("2 minutes")
      const refused = yield* Effect.flip(
        approveApproval(dependencies, { tenantId: defaultTenantId, id: late.approvalId, decidedBy: "ann" })
      )

      expect(refused._tag).toBe("ApprovalConflict")
      expect(summary(decided).map(([status]) => status)).toEqual(["expired", "expired"])
      expect(decided.map((event) => event.approvalId).toSorted()).toEqual(
        [swept.approvalId, late.approvalId].toSorted()
      )
    }).pipe(Effect.provide(hostLayer(seen)))
  })

  it.effect("when its profile is revoked, and when a human approves and saves the approval", () => {
    const seen: Array<HostToolInvocation> = []
    return Effect.gen(function* () {
      const { profile, dependencies, invoke, decided, store } = yield* harness({ decision: "require_approval" })
      const remembered = yield* invoke("ls")
      if (remembered.status !== "pending") return yield* Effect.die("expected pending")
      yield* decideWaitingApproval(dependencies, {
        tenantId: defaultTenantId,
        id: remembered.approvalId,
        verdict: "approve",
        decidedBy: "ann (in-client approval)",
        remember: true,
        relay: false
      })
      const cancelled = yield* invoke("rm -rf /")
      if (cancelled.status !== "pending") return yield* Effect.die("expected pending")

      yield* store.revokeProfile(defaultTenantId, profile.id)
      yield* store.cancelApprovalsForProfile(profile.id)

      expect(summary(decided).map(([status, by]) => [status, by])).toEqual([
        ["approved", "ann (in-client approval)"],
        ["denied", "profile-revoked"]
      ])
    }).pipe(Effect.provide(hostLayer(seen)))
  })

  it.effect("a failing hook neither undoes nor fails the decision", () => {
    const seen: Array<HostToolInvocation> = []
    return Effect.gen(function* () {
      const { dependencies, invoke, store } = yield* harness({ decision: "require_approval" })
      const loud = notifyingDecisions(store, () => Effect.die("the host fell over"))
      const pending = yield* invoke("make")
      if (pending.status !== "pending") return yield* Effect.die("expected pending")

      const { outcome } = yield* approveApproval(
        { ...dependencies, store: loud },
        { tenantId: defaultTenantId, id: pending.approvalId, decidedBy: "ann" }
      )

      expect(outcome.status).toBe("succeeded")
      expect((yield* store.getApproval(defaultTenantId, pending.approvalId))?.status).toBe("approved")
    }).pipe(Effect.provide(hostLayer(seen)))
  })
})
