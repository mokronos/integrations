import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { testServices } from "./fixtures.ts"
import { defaultTenantId } from "./gateway.ts"
import { setup } from "./http-support.ts"

describe("frozen calls and retries", () => {
  /** The one call these tests freeze, retry and collect. */
  const sendEmail = (args: Record<string, typeof Schema.Json.Type> = { to: "a@b.c" }) => ({
    body: { alias: "user___sebastian___gmail___work", tool: "sendEmail", arguments: args }
  })

  it.effect("different arguments are a different frozen call", () =>
    Effect.gen(function* () {
      const { call, store } = yield* setup({
        decision: "require_approval",
        capabilities: ["provision_connections", "administer_gateway"]
      })

      const first = yield* call("POST", "/v1/execute", sendEmail({ to: "a@b.c" }))
      const second = yield* call("POST", "/v1/execute", sendEmail({ to: "someone-else@b.c" }))

      expect(second.body["approvalId"]).not.toBe(first.body["approvalId"])
      expect(yield* store.listApprovals(defaultTenantId, "pending")).toHaveLength(2)
    }).pipe(Effect.provide(testServices))
  )

  it.effect("the retry after approval collects the result exactly once", () =>
    Effect.gen(function* () {
      const { call, store, calls } = yield* setup({
        decision: "require_approval",
        capabilities: ["provision_connections", "administer_gateway"]
      })
      const frozen = yield* call("POST", "/v1/execute", sendEmail())
      const approvalId = String(frozen.body["approvalId"])
      yield* call("POST", `/v1/approvals/${approvalId}/approve`, {
        body: {},
        local: true
      })
      expect(calls).toHaveLength(1)

      const collected = yield* call("POST", "/v1/execute", sendEmail())
      expect(collected.body["status"]).toBe("succeeded")
      expect(collected.body["result"]).toEqual({ ok: true })
      expect(calls).toHaveLength(1)

      const afterCollection = yield* call("POST", "/v1/execute", sendEmail())
      expect(afterCollection.body["status"]).toBe("pending")
      expect(afterCollection.body["approvalId"]).not.toBe(approvalId)
      expect(yield* store.listApprovals(defaultTenantId, "pending")).toHaveLength(1)
    }).pipe(Effect.provide(testServices))
  )

  it.effect("a denial is delivered to the caller rather than left pending forever", () =>
    Effect.gen(function* () {
      const { call } = yield* setup({
        decision: "require_approval",
        capabilities: ["provision_connections", "administer_gateway"]
      })
      const frozen = yield* call("POST", "/v1/execute", sendEmail())
      const approvalId = String(frozen.body["approvalId"])
      yield* call("POST", `/v1/approvals/${approvalId}/deny`, {
        body: { decidedBy: "sebastian" },
        local: true
      })

      const collected = yield* call("POST", "/v1/execute", sendEmail())

      expect(collected.status).toBe(403)
      expect(collected.body["status"]).toBe("denied")
      expect(String(collected.body["reason"])).toContain("local:support-agent")
      expect(String(collected.body["reason"])).not.toContain("sebastian")
    }).pipe(Effect.provide(testServices))
  )

  it.effect("the caller can read its own frozen call without an administrative key", () =>
    Effect.gen(function* () {
      const { call } = yield* setup({ decision: "require_approval" })
      const frozen = yield* call("POST", "/v1/execute", sendEmail())

      const polled = yield* call("GET", `/v1/approvals/${String(frozen.body["approvalId"])}`)

      expect(polled.status).toBe(200)
      expect(polled.body["status"]).toBe("pending")
      expect(polled.body["collectedAt"]).toBeNull()
    }).pipe(Effect.provide(testServices))
  )
})
