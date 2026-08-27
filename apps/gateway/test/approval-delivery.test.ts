import { run } from "./effect.ts"
import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { deliverApprovalNotification, ApprovalNotification } from "../src/approval-delivery.ts"
import { ApprovalId, ClientId, TenantId } from "../src/domain.ts"

const decodeNotification = Schema.decodeUnknownSync(
  Schema.fromJsonString(ApprovalNotification)
)

interface DeliveryCapture {
  notification?: ApprovalNotification
  idempotencyKey?: string
}

describe("approval delivery", () => {
  test("posts only review metadata to configured webhooks", async () => {
    const capture: DeliveryCapture = {}
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        capture.notification = decodeNotification(await run(request.text()))
        const idempotencyKey = request.headers.get("idempotency-key")
        if (idempotencyKey !== null) capture.idempotencyKey = idempotencyKey
        return new Response(null, { status: 204 })
      }
    })
    try {
      const approvalId = ApprovalId.make("ap_delivery")
      await run(deliverApprovalNotification({
        client: {
          id: ClientId.make("client-delivery"),
          tenantId: TenantId.make("tenant-delivery"),
          name: "support-agent",
          capabilities: [],
          approvalDelivery: {
            returnLink: true,
            webhooks: [`http://127.0.0.1:${server.port}/approval`]
          },
          createdAt: new Date(),
          revokedAt: null
        },
        approvalId,
        alias: "mail",
        tool: "sendEmail",
        expiresAt: new Date("2030-01-01T00:00:00.000Z"),
        approvalUrl: "https://gateway.example/approvals?approval=ap_delivery"
      }))

      expect(capture.notification).toEqual({
        version: 1,
        event: "approval.pending",
        approvalId: "ap_delivery",
        clientId: "client-delivery",
        clientName: "support-agent",
        alias: "mail",
        tool: "sendEmail",
        expiresAt: "2030-01-01T00:00:00.000Z",
        approvalUrl: "https://gateway.example/approvals?approval=ap_delivery"
      })
      expect(capture.idempotencyKey).toBe(approvalId)
      expect(JSON.stringify(capture.notification)).not.toContain("arguments")
      expect(JSON.stringify(capture.notification)).not.toContain("credential")
    } finally {
      server.stop(true)
    }
  })
})
