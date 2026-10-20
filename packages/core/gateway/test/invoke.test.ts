import { describe, expect, it } from "@effect/vitest"
import { Clock, Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { IdempotencyKey, whenPresent, whenPresentMap } from "@integragents/contracts"
import {
  HostTools,
  Integrations,
  McpClient,
  OpenApiInvoker,
  stubbedLayer,
  unavailableHttpClientLayer
} from "@integragents/host"
import type { BlobStore, HostIntegrationDefinition, HostToolInvocation } from "@integragents/host"
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
  runMaintenance,
  SubjectId,
  ToolName,
  unattributedOrigin
} from "../src/index.ts"
import type {
  ApprovalDecided,
  ApprovalId,
  ApprovalReviewer,
  ApprovalReviewRequest,
  ReviewVerdict,
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

const unusedBlobs: BlobStore["Service"] = {
  write: () => Effect.die("unused"),
  readAll: () => Effect.die("unused"),
  readPrefix: () => Effect.die("unused"),
  open: () => Effect.die("unused"),
  discard: () => Effect.die("unused"),
  expire: () => Effect.succeed(0)
}

const harness = Effect.fnUntraced(function* (
  options: {
    readonly decision?: ToolDecision
    readonly profile?: Partial<CreateProfileInput>
    readonly reviewer?: ApprovalReviewer["Service"]
  } = {}
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
  const notified: Array<ApprovalId> = []
  const invoke = (
    command: string,
    extra: { readonly subject?: typeof alice; readonly profile?: Profile; readonly key?: string } = {}
  ) =>
    invokeAsProfile(
      {
        ...dependencies,
        ...whenPresent("reviewer", options.reviewer),
        onApprovalCreated: (created) =>
          Effect.sync(() => {
            notified.push(created.approvalId)
          })
      },
      {
        profile: extra.profile ?? profile,
        origin: unattributedOrigin,
        alias,
        tool: runCommand,
        arguments: { command },
        ...whenPresent("subject", extra.subject),
        ...whenPresentMap("idempotencyKey", extra.key, IdempotencyKey.make)
      }
    )
  return { store, integrations, profile, dependencies, invoke, decided, notified }
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

describe("a call whose execution was interrupted", () => {
  it.effect("is settled as unknown once its claim outlives the lease, never run again, and reported", () => {
    const seen: Array<HostToolInvocation> = []
    return Effect.gen(function* () {
      const { store, invoke, decided } = yield* harness({ decision: "require_approval" })
      const crashed = yield* invoke("migrate the database")
      const running = yield* invoke("long backup")
      if (crashed.status !== "pending" || running.status !== "pending") return yield* Effect.die("expected pending")
      // The process that claimed this one stopped before it recorded what happened.
      yield* store.claimApproval({ tenantId: defaultTenantId, id: crashed.approvalId, decidedBy: "ann" })
      yield* TestClock.adjust("50 minutes")
      yield* store.claimApproval({ tenantId: defaultTenantId, id: running.approvalId, decidedBy: "ann" })
      yield* TestClock.adjust("20 minutes")

      const report = yield* runMaintenance(store, unusedBlobs, undefined, { executionLease: "1 hour" })

      expect(report.interruptedApprovals).toBe(1)
      const settled = yield* store.getApproval(defaultTenantId, crashed.approvalId)
      expect([settled?.status, settled?.error]).toEqual(["approved", expect.stringContaining("outcome unknown")])
      expect((yield* store.getApproval(defaultTenantId, running.approvalId))?.status).toBe("executing")
      expect(decided.map((event) => [event.approvalId, event.outcome.status])).toEqual([[crashed.approvalId, "failed"]])
      expect((yield* auditOf(store)).filter(([outcome]) => outcome === "failed")).toEqual([
        ["failed", "approved", expect.stringContaining("outcome unknown")]
      ])
      const retried = yield* invoke("migrate the database")
      expect(retried.status === "failed" ? retried.message : retried.status).toContain("outcome unknown")
      expect(seen).toEqual([])
    }).pipe(Effect.provide(hostLayer(seen)))
  })
})

describe("approving with edited arguments", () => {
  it.effect("runs the edited call, checked against the tool's schema, and keeps both versions", () => {
    const seen: Array<HostToolInvocation> = []
    return Effect.gen(function* () {
      const { store, dependencies, invoke, decided } = yield* harness({ decision: "require_approval" })
      const pending = yield* invoke("rm -rf /")
      if (pending.status !== "pending") return yield* Effect.die("expected pending")
      const decision = { tenantId: defaultTenantId, id: pending.approvalId, decidedBy: "ann" }

      const refused = yield* Effect.flip(approveApproval(dependencies, { ...decision, arguments: { command: 42 } }))
      const { approval, outcome } = yield* approveApproval(dependencies, {
        ...decision,
        arguments: { command: "rm -rf ./build" }
      })

      expect(refused._tag).toBe("ApprovalArgumentsInvalid")
      expect(seen.map((call) => call.arguments)).toEqual([{ command: "rm -rf ./build" }])
      expect(outcome).toEqual({ status: "succeeded", result: { exitCode: 0, ran: { command: "rm -rf ./build" } } })
      expect([approval.arguments, approval.editedArguments]).toEqual([
        { command: "rm -rf /" },
        { command: "rm -rf ./build" }
      ])
      expect(decided.map((event) => event.approval.editedArguments)).toEqual([{ command: "rm -rf ./build" }])
      expect((yield* auditOf(store)).filter(([outcome]) => outcome === "succeeded")).toEqual([
        ["succeeded", "approved", "approved by ann with edited arguments"]
      ])
      const collected = yield* invoke("rm -rf /")
      expect(collected.status).toBe("succeeded")
    }).pipe(Effect.provide(hostLayer(seen)))
  })
})

describe("a reviewer the host provides", () => {
  const reviewing = (
    verdict: (request: ApprovalReviewRequest) => ReviewVerdict,
    asked: Array<ApprovalReviewRequest>
  ) => ({
    name: "policy-bot",
    review: (request: ApprovalReviewRequest) =>
      Effect.sync(() => {
        asked.push(request)
        return verdict(request)
      })
  })

  it.effect("approves a call at once, so it runs without a human and is recorded as the reviewer's", () => {
    const seen: Array<HostToolInvocation> = []
    const asked: Array<ApprovalReviewRequest> = []
    return Effect.gen(function* () {
      const { store, invoke, decided, notified } = yield* harness({
        decision: "require_approval",
        reviewer: reviewing(() => ({ verdict: "approve", reason: "read-only listing" }), asked)
      })

      const outcome = yield* invoke("ls")

      expect(outcome).toEqual({ status: "succeeded", result: { exitCode: 0, ran: { command: "ls" } } })
      expect(seen).toHaveLength(1)
      expect(notified).toEqual([])
      expect(asked.map((request) => [request.tool.name, request.tool.destructive, request.approval.arguments])).toEqual(
        [[runCommand, true, { command: "ls" }]]
      )
      expect(decided.map((event) => [event.status, event.decidedBy])).toEqual([["approved", "reviewer:policy-bot"]])
      expect((yield* auditOf(store)).filter(([outcome]) => outcome === "succeeded")).toEqual([
        ["succeeded", "approved", "approved by reviewer:policy-bot: read-only listing"]
      ])
    }).pipe(Effect.provide(hostLayer(seen)))
  })

  it.effect("denies a call, so it never runs and the caller hears why", () => {
    const seen: Array<HostToolInvocation> = []
    const asked: Array<ApprovalReviewRequest> = []
    return Effect.gen(function* () {
      const { store, invoke, decided, notified } = yield* harness({
        decision: "require_approval",
        reviewer: reviewing(() => ({ verdict: "deny", reason: "wipes the disk" }), asked)
      })

      const outcome = yield* invoke("rm -rf /")

      expect(outcome.status === "denied" ? outcome.reason : outcome.status).toMatch(
        /was denied by reviewer:policy-bot: wipes the disk$/
      )
      expect([seen, notified]).toEqual([[], []])
      expect(decided.map((event) => [event.status, event.decidedBy])).toEqual([["denied", "reviewer:policy-bot"]])
      expect((yield* auditOf(store)).filter(([outcome]) => outcome === "denied")).toEqual([
        ["denied", null, expect.stringContaining("denied by reviewer:policy-bot: wipes the disk")]
      ])
    }).pipe(Effect.provide(hostLayer(seen)))
  })

  it.effect("leaves a call to a human when it escalates, or when it fails", () => {
    const seen: Array<HostToolInvocation> = []
    const asked: Array<ApprovalReviewRequest> = []
    return Effect.gen(function* () {
      const escalating = yield* harness({
        decision: "require_approval",
        reviewer: reviewing(() => ({ verdict: "escalate", reason: "touches production" }), asked)
      })
      const failing = yield* harness({
        decision: "require_approval",
        reviewer: { name: "flaky", review: () => Effect.die("the model is down") }
      })

      const escalated = yield* escalating.invoke("deploy")
      const unreviewed = yield* failing.invoke("deploy")

      expect([escalated.status, unreviewed.status]).toEqual(["pending", "pending"])
      expect([escalating.notified.length, failing.notified.length]).toEqual([1, 1])
      expect([escalating.decided, failing.decided, seen]).toEqual([[], [], []])
      expect(yield* auditOf(escalating.store)).toEqual([
        [
          "pending",
          null,
          `approval ${escalated.status === "pending" ? escalated.approvalId : ""}; reviewer:policy-bot left it to a human: touches production`
        ]
      ])
    }).pipe(Effect.provide(hostLayer(seen)))
  })
})

describe("an idempotency key", () => {
  it.effect("answers a repeat with what the first call got, without running it again", () => {
    const seen: Array<HostToolInvocation> = []
    return Effect.gen(function* () {
      const { invoke, store } = yield* harness()

      const first = yield* invoke("date", { key: "turn-7/call-1" })
      const repeat = yield* invoke("date", { key: "turn-7/call-1" })
      const other = yield* invoke("date", { key: "turn-7/call-2" })
      const reused = yield* invoke("rm -rf /", { key: "turn-7/call-1" })

      expect(repeat).toEqual(first)
      expect(other.status).toBe("succeeded")
      expect(seen.map((call) => call.context.idempotencyKey)).toEqual(["turn-7/call-1", "turn-7/call-2"])
      expect(reused.status === "invalid" ? reused.message : reused.status).toContain("turn-7/call-1")
      expect((yield* auditOf(store)).filter(([outcome]) => outcome === "succeeded")).toHaveLength(2)
    }).pipe(Effect.provide(hostLayer(seen)))
  })

  it.effect("keeps two deliberate identical calls apart and answers each repeat from its own approval", () => {
    const seen: Array<HostToolInvocation> = []
    return Effect.gen(function* () {
      const { invoke, dependencies, store } = yield* harness({ decision: "require_approval" })

      const first = yield* invoke("deploy", { key: "a" })
      const second = yield* invoke("deploy", { key: "b" })
      const unkeyed = yield* invoke("deploy")
      const waiting = yield* invoke("deploy", { key: "a" })
      if (first.status !== "pending" || second.status !== "pending" || unkeyed.status !== "pending") {
        return yield* Effect.die("expected pending")
      }
      expect(new Set([first.approvalId, second.approvalId, unkeyed.approvalId]).size).toBe(3)
      expect(waiting).toEqual(first)
      expect((yield* store.getApproval(defaultTenantId, first.approvalId))?.idempotencyKey).toBe("a")

      yield* approveApproval(dependencies, { tenantId: defaultTenantId, id: first.approvalId, decidedBy: "ann" })
      yield* denyApproval(store, { tenantId: defaultTenantId, id: second.approvalId, decidedBy: "ann" })
      const collected = yield* invoke("deploy", { key: "a" })
      const again = yield* invoke("deploy", { key: "a" })
      const refused = yield* invoke("deploy", { key: "b" })
      const unkeyedAgain = yield* invoke("deploy")

      expect(collected).toEqual({ status: "succeeded", result: { exitCode: 0, ran: { command: "deploy" } } })
      expect(again).toEqual(collected)
      expect(refused.status).toBe("denied")
      expect(unkeyedAgain).toEqual(unkeyed)
      expect(seen.map((call) => [call.context.approvalId, call.context.idempotencyKey])).toEqual([
        [first.approvalId, "a"]
      ])
      expect(
        (yield* auditOf(store)).filter(([, , message]) => String(message).startsWith("result of approval"))
      ).toHaveLength(1)
    }).pipe(Effect.provide(hostLayer(seen)))
  })

  it.effect("does not run a call again whose first run was interrupted, and maintenance settles it", () => {
    const seen: Array<HostToolInvocation> = []
    return Effect.gen(function* () {
      const { invoke, store, profile } = yield* harness()
      // A gateway that stopped mid-call leaves the key claimed with no outcome.
      yield* store.claimInvocationKey({
        tenantId: defaultTenantId,
        profileId: profile.id,
        key: IdempotencyKey.make("crashed"),
        call: { alias, tool: runCommand, subject: null, arguments: { command: "migrate" } }
      })

      const retried = yield* invoke("migrate", { key: "crashed" })
      yield* TestClock.adjust("2 hours")
      const report = yield* runMaintenance(store, unusedBlobs)
      const afterSweep = yield* invoke("migrate", { key: "crashed" })

      expect(retried.status === "failed" ? retried.message : retried.status).toContain("not run again")
      expect(report.interruptedInvocations).toBe(1)
      expect(afterSweep.status === "failed" ? afterSweep.message : afterSweep.status).toContain("outcome unknown")
      expect(seen).toEqual([])
    }).pipe(Effect.provide(hostLayer(seen)))
  })
})
