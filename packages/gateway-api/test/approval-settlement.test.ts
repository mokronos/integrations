import { describe, expect, it } from "@effect/vitest"
import { Clock, Effect, Fiber, Schema } from "effect"
import { storeOn, testServices } from "./fixtures.ts"
import { aliasForConnection, ConnectionName, defaultTenantId } from "./gateway.ts"
import { connection, setup, profileWithKey, sendEmailOn } from "./http-support.ts"

describe("gateway approval settlement", () => {
  it.effect("simultaneous retries freeze one invocation and record one approval event", () =>
    Effect.gen(function* () {
      const { call, store } = yield* setup({ decision: "require_approval" })
      const body = { alias: aliasForConnection(connection), tool: "sendEmail", arguments: { to: "a@b.c" } }
      const responses = yield* Effect.all(
        Array.from({ length: 8 }, () => call("POST", "/v1/execute", { body })),
        { concurrency: "unbounded" }
      )
      expect(responses.every((response) => response.status === 200)).toBe(true)
      expect(new Set(responses.map((response) => response.body["approvalId"])).size).toBe(1)
      expect(yield* store.listApprovals(defaultTenantId)).toHaveLength(1)
    }).pipe(Effect.provide(testServices))
  )

  it.effect("profiles holding the same tool cannot share or collect each other's approval", () =>
    Effect.gen(function* () {
      const { call, store } = yield* setup({ decision: "require_approval" })
      const { key } = yield* profileWithKey(store, "other-agent", [sendEmailOn(connection, "require_approval")])
      const body = { alias: aliasForConnection(connection), tool: "sendEmail", arguments: { to: "a@b.c" } }
      const first = yield* call("POST", "/v1/execute", { body })
      const second = yield* call("POST", "/v1/execute", { body, secret: key.secret })
      expect(second.body["approvalId"]).not.toBe(first.body["approvalId"])
      yield* call("POST", `/v1/approvals/${String(first.body["approvalId"])}/approve`, { body: {}, local: true })
      const retry = yield* call("POST", "/v1/execute", { body, secret: key.secret })
      expect(retry.body["status"]).toBe("pending")
      expect(retry.body["approvalId"]).toBe(second.body["approvalId"])
      expect((yield* call("POST", "/v1/execute", { body })).body["status"]).toBe("succeeded")
    }).pipe(Effect.provide(testServices))
  )

  it.effect("the same tool and arguments on different accounts keep distinct approvals and targets", () =>
    Effect.gen(function* () {
      const { call, store, profile, calls } = yield* setup({ decision: "require_approval" })
      const personal = { ...connection, name: ConnectionName.make("personal") }
      yield* store.replaceProfileTools(
        profile.id,
        [connection, personal].map((on) => sendEmailOn(on, "require_approval"))
      )
      const first = yield* call("POST", "/v1/execute", {
        body: { alias: aliasForConnection(connection), tool: "sendEmail", arguments: { to: "a@b.c" } }
      })
      const second = yield* call("POST", "/v1/execute", {
        body: { alias: aliasForConnection(personal), tool: "sendEmail", arguments: { to: "a@b.c" } }
      })
      expect(second.body["approvalId"]).not.toBe(first.body["approvalId"])
      const response = yield* call("POST", `/v1/approvals/${String(second.body["approvalId"])}/approve`, {
        body: {},
        local: true
      })
      expect(response.status).toBe(200)
      expect(calls).toEqual([{ address: "tools.gmail.user:sebastian.personal.sendEmail", input: { to: "a@b.c" } }])
    }).pipe(Effect.provide(testServices))
  )

  it.effect("concurrent decisions cannot execute twice, deny an executing call, or collect it early", () =>
    Effect.gen(function* () {
      const started = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const { call, calls, store } = yield* setup({
        decision: "require_approval",
        beforeExecute: () => {
          started.resolve()
          return release.promise
        }
      })
      const body = { alias: aliasForConnection(connection), tool: "sendEmail", arguments: { to: "a@b.c" } }
      const frozen = yield* call("POST", "/v1/execute", { body })
      const id = String(frozen.body["approvalId"])

      const approving = yield* Effect.forkChild(call("POST", `/v1/approvals/${id}/approve`, { body: {}, local: true }))
      yield* Effect.promise(() => started.promise)
      const [approve, deny, retry] = yield* Effect.all(
        [
          call("POST", `/v1/approvals/${id}/approve`, { body: {}, local: true }),
          call("POST", `/v1/approvals/${id}/deny`, { body: {}, local: true }),
          call("POST", "/v1/execute", { body })
        ],
        { concurrency: "unbounded" }
      )

      expect([approve.status, approve.body["_tag"]]).toEqual([409, "ApprovalConflict"])
      expect([deny.status, deny.body["_tag"]]).toEqual([409, "ApprovalConflict"])
      expect(retry.body["approvalId"]).toBe(id)
      expect(retry.body["status"]).toBe("pending")
      // A cutoff well past the freeze: an executing call is not pending, so
      // maintenance leaves it alone rather than expiring it mid-flight.
      const wellPast = new Date((yield* Clock.currentTimeMillis) + 86_400_000)
      expect(yield* store.expireApprovals(wellPast)).toEqual([])
      expect(calls).toHaveLength(1)

      release.resolve()
      yield* Fiber.join(approving)
      expect((yield* call("POST", "/v1/execute", { body })).body["status"]).toBe("succeeded")
      expect(calls).toHaveLength(1)
    }).pipe(Effect.provide(testServices))
  )

  it.effect("a durable execution claim survives reopening the store and cannot be replayed", () =>
    Effect.gen(function* () {
      const { call, store, sql, calls } = yield* setup({ decision: "require_approval" })
      const body = { alias: aliasForConnection(connection), tool: "sendEmail", arguments: { to: "a@b.c" } }
      const frozen = yield* call("POST", "/v1/execute", { body })
      const approval = (yield* store.listApprovals(defaultTenantId))[0]
      if (approval === undefined) throw new Error("Missing approval")
      yield* store.claimApproval({ tenantId: defaultTenantId, id: approval.id, decidedBy: "human" })
      const reopened = yield* storeOn(sql)
      expect((yield* reopened.getApproval(defaultTenantId, approval.id))?.status).toBe("executing")
      expect(
        yield* reopened.claimApproval({
          tenantId: defaultTenantId,
          id: approval.id,
          decidedBy: "human"
        })
      ).toBe(false)
      expect(yield* reopened.collectApproval(defaultTenantId, approval.id)).toBe(false)
      expect(
        (yield* call("POST", `/v1/approvals/${String(frozen.body["approvalId"])}/approve`, { body: {}, local: true }))
          .status
      ).toBe(409)
      expect((yield* call("POST", "/v1/execute", { body })).body["approvalId"]).toBe(approval.id)
      expect(calls).toHaveLength(0)
    }).pipe(Effect.provide(testServices))
  )

  it.effect("an administrative API key cannot make a human approval decision", () =>
    Effect.gen(function* () {
      const { call, calls } = yield* setup({
        decision: "require_approval",
        capabilities: ["provision_connections", "administer_gateway"]
      })
      const frozen = yield* call("POST", "/v1/execute", {
        body: { alias: "user___sebastian___gmail___work", tool: "sendEmail", arguments: { to: "a@b.c" } }
      })
      const approvalId = String(frozen.body["approvalId"])

      const approved = yield* call("POST", `/v1/approvals/${approvalId}/approve`, {
        body: { decidedBy: "api-key" }
      })
      const denied = yield* call("POST", `/v1/approvals/${approvalId}/deny`, {
        body: { decidedBy: "api-key" }
      })

      expect(approved.status).toBe(403)
      expect(denied.status).toBe(403)
      expect(calls).toHaveLength(0)
    }).pipe(Effect.provide(testServices))
  )

  it.effect("a reviewer the host provides decides a call on /v1/execute before a human is asked", () =>
    Effect.gen(function* () {
      const { call, calls } = yield* setup({
        decision: "require_approval",
        reviewer: {
          name: "policy-bot",
          review: (request) =>
            Effect.succeed(
              JSON.stringify(request.approval.arguments).includes("everyone")
                ? { verdict: "deny" as const, reason: "no mass mail" }
                : { verdict: "approve" as const }
            )
        }
      })
      const send = (to: string) =>
        call("POST", "/v1/execute", {
          body: { alias: "user___sebastian___gmail___work", tool: "sendEmail", arguments: { to } }
        })

      const denied = yield* send("everyone@b.c")
      const approved = yield* send("a@b.c")

      expect([denied.status, String(denied.body["reason"])]).toEqual([
        403,
        expect.stringContaining("denied by reviewer:policy-bot: no mass mail")
      ])
      expect([approved.status, approved.body["status"]]).toEqual([200, "succeeded"])
      expect(calls.map((entry) => entry.input)).toEqual([{ to: "a@b.c" }])
    }).pipe(Effect.provide(testServices))
  )

  it.effect("an approver may run the call with edited arguments the tool's schema accepts", () =>
    Effect.gen(function* () {
      const { call, calls } = yield* setup({
        decision: "require_approval",
        capabilities: ["provision_connections", "administer_gateway"]
      })
      const frozen = yield* call("POST", "/v1/execute", {
        body: { alias: "user___sebastian___gmail___work", tool: "sendEmail", arguments: { to: "everyone@b.c" } }
      })
      const approvalId = String(frozen.body["approvalId"])

      const refused = yield* call("POST", `/v1/approvals/${approvalId}/approve`, {
        body: { arguments: { cc: "a@b.c" } },
        local: true
      })
      const approved = yield* call("POST", `/v1/approvals/${approvalId}/approve`, {
        body: { arguments: { to: "a@b.c" } },
        local: true
      })

      expect([refused.status, refused.body["_tag"]]).toEqual([400, "InvalidInput"])
      expect(refused.body["issues"]).toEqual([expect.objectContaining({ path: "to" })])
      expect(approved.status).toBe(200)
      expect(calls.map((entry) => entry.input)).toEqual([{ to: "a@b.c" }])
      expect(approved.body["approval"]).toMatchObject({
        arguments: { to: "everyone@b.c" },
        editedArguments: { to: "a@b.c" }
      })
    }).pipe(Effect.provide(testServices))
  )

  it.effect("the gateway performs the call itself once approved", () =>
    Effect.gen(function* () {
      const { call, calls } = yield* setup({
        decision: "require_approval",
        capabilities: ["provision_connections", "administer_gateway"]
      })
      const frozen = yield* call("POST", "/v1/execute", {
        body: { alias: "user___sebastian___gmail___work", tool: "sendEmail", arguments: { to: "a@b.c" } }
      })
      const approvalId = String(frozen.body["approvalId"])
      expect(calls).toHaveLength(0)

      const approved = yield* call("POST", `/v1/approvals/${approvalId}/approve`, {
        body: { decidedBy: "sebastian" },
        local: true
      })

      expect(approved.status).toBe(200)
      expect(calls).toHaveLength(1)
      expect(calls[0]?.input).toEqual({ to: "a@b.c" })
    }).pipe(Effect.provide(testServices))
  )

  it.effect("groups calls to one tool and decides them together, reporting each call", () =>
    Effect.gen(function* () {
      const { call, calls } = yield* setup({
        decision: "require_approval",
        capabilities: ["provision_connections", "administer_gateway"]
      })
      const freeze = (to: string) =>
        call("POST", "/v1/execute", {
          body: { alias: "user___sebastian___gmail___work", tool: "sendEmail", arguments: { to, subject: "Launch" } }
        })
      const first = String((yield* freeze("a@b.c")).body["approvalId"])
      const second = String((yield* freeze("d@e.f")).body["approvalId"])
      const listed = yield* call("GET", "/v1/approvals?status=pending", { local: true })
      expect(listed.body["approvals"]).toMatchObject([
        { id: second, groupId: first },
        { id: first, groupId: first }
      ])

      yield* call("POST", `/v1/approvals/${first}/deny`, { body: {}, local: true })
      const decided = yield* call("POST", "/v1/approvals/decide", {
        body: { verdict: "approve", ids: [first, second] },
        local: true
      })

      expect(decided.status).toBe(200)
      expect(decided.body["results"]).toMatchObject([
        { id: first, status: "refused" },
        { id: second, status: "decided", approval: { status: "approved" } }
      ])
      expect(calls.map((entry) => entry.input)).toEqual([{ to: "d@e.f", subject: "Launch" }])
    }).pipe(Effect.provide(testServices))
  )

  it.effect("always approve saves the shared pattern and runs later calls of the same profile that fit it", () =>
    Effect.gen(function* () {
      const { call, calls, profile, store } = yield* setup({
        decision: "require_approval",
        capabilities: ["provision_connections", "administer_gateway"]
      })
      const other = yield* profileWithKey(store, "other-agent", [sendEmailOn(connection, "require_approval")])
      const send = (argumentsValue: typeof Schema.Json.Type) =>
        call("POST", "/v1/execute", {
          body: { alias: "user___sebastian___gmail___work", tool: "sendEmail", arguments: argumentsValue }
        })
      const first = String((yield* send({ to: "a@b.c", subject: "Launch" })).body["approvalId"])
      const second = String((yield* send({ to: "d@e.f", subject: "Launch" })).body["approvalId"])

      const decided = yield* call("POST", "/v1/approvals/decide", {
        body: { verdict: "approve", ids: [first, second], remember: true },
        local: true
      })
      expect(decided.body["rule"]).toMatchObject({ pinned: [{ path: ["subject"], value: "Launch" }], free: [["to"]] })

      expect((yield* send({ to: "g@h.i", subject: "Launch" })).body["status"]).toBe("succeeded")
      const runs = Schema.decodeUnknownSync(
        Schema.Struct({
          records: Schema.Array(Schema.Struct({ outcome: Schema.String, approval: Schema.NullOr(Schema.String) }))
        })
      )((yield* call("GET", `/v1/audit?profileId=${profile.id}&outcome=succeeded`, { local: true })).body)
      expect(runs.records.map((record) => record.approval)).toEqual([
        "saved_approval",
        "approved_always",
        "approved_always"
      ])
      expect((yield* send({ to: "g@h.i", subject: "Other" })).body["status"]).toBe("pending")
      expect((yield* send({ to: "g@h.i", subject: "Launch", bcc: "x@y.z" })).body["status"]).toBe("pending")
      expect(calls).toHaveLength(3)
      const fromOther = yield* call("POST", "/v1/execute", {
        body: {
          alias: "user___sebastian___gmail___work",
          tool: "sendEmail",
          arguments: { to: "g@h.i", subject: "Launch" }
        },
        secret: other.key.secret
      })
      expect(fromOther.body["status"]).toBe("pending")
      expect(calls).toHaveLength(3)

      const rules = yield* call("GET", `/v1/profiles/${profile.id}/approval-rules`, { local: true })
      const ruleId = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(decided.body["rule"]).id
      expect(rules.body["rules"]).toMatchObject([{ id: ruleId }])
      expect(
        (yield* call("GET", `/v1/profiles/${other.profile.id}/approval-rules`, { local: true })).body["rules"]
      ).toEqual([])
      const loosened = yield* call("POST", `/v1/approval-rules/${ruleId}`, {
        body: { pinned: [], free: [["to"], ["subject"]] },
        local: true
      })
      expect(loosened.status).toBe(200)
      expect((yield* send({ to: "g@h.i", subject: "Anything" })).body["status"]).toBe("succeeded")

      expect((yield* call("DELETE", `/v1/approval-rules/${ruleId}`, { local: true })).status).toBe(200)
      expect((yield* send({ to: "j@k.l", subject: "Launch" })).body["status"]).toBe("pending")
    }).pipe(Effect.provide(testServices))
  )

  it.effect("refuses to approve twice", () =>
    Effect.gen(function* () {
      const { call } = yield* setup({
        decision: "require_approval",
        capabilities: ["provision_connections", "administer_gateway"]
      })
      const frozen = yield* call("POST", "/v1/execute", {
        body: { alias: "user___sebastian___gmail___work", tool: "sendEmail", arguments: { to: "a@b.c" } }
      })
      const approvalId = String(frozen.body["approvalId"])

      expect((yield* call("POST", `/v1/approvals/${approvalId}/approve`, { body: {}, local: true })).status).toBe(200)
      expect(
        (yield* call("POST", `/v1/approvals/${approvalId}/approve`, { body: {}, local: true })).body
      ).toMatchObject({
        _tag: "ApprovalConflict",
        state: "decided"
      })
    }).pipe(Effect.provide(testServices))
  )

  it.effect("refuses an approval once the tool was turned off for the profile", () =>
    Effect.gen(function* () {
      const { call, calls, store, profile } = yield* setup({
        decision: "require_approval",
        capabilities: ["provision_connections", "administer_gateway"]
      })
      const stale = yield* call("POST", "/v1/execute", {
        body: { alias: "user___sebastian___gmail___work", tool: "sendEmail", arguments: { to: "a@b.c" } }
      })
      yield* store.replaceProfileTools(profile.id, [])
      expect(
        (yield* call("POST", `/v1/approvals/${String(stale.body["approvalId"])}/approve`, { body: {}, local: true }))
          .body
      ).toMatchObject({ _tag: "ApprovalConflict", state: "unauthorized" })
      expect(calls).toHaveLength(0)
    }).pipe(Effect.provide(testServices))
  )

  it.effect("denying settles without performing the call", () =>
    Effect.gen(function* () {
      const { call, calls } = yield* setup({
        decision: "require_approval",
        capabilities: ["provision_connections", "administer_gateway"]
      })
      const frozen = yield* call("POST", "/v1/execute", {
        body: { alias: "user___sebastian___gmail___work", tool: "sendEmail", arguments: { to: "a@b.c" } }
      })
      const approvalId = String(frozen.body["approvalId"])

      const denied = yield* call("POST", `/v1/approvals/${approvalId}/deny`, {
        body: { decidedBy: "sebastian" },
        local: true
      })

      expect(denied.status).toBe(200)
      expect(calls).toHaveLength(0)
    }).pipe(Effect.provide(testServices))
  )
})
