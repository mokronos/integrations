import { describe, expect, test } from "bun:test"
import {
  approvalWebhookSignature,
  verifyApprovalWebhookSignature
} from "../src/approval-delivery.ts"

describe("approval delivery", () => {
  test("signs the timestamp and exact request body", () => {
    const input = { secret: "wfs_test", timestamp: "1893456000", body: "{\"event\":\"approval.pending\"}" }
    const signature = approvalWebhookSignature(input.secret, input.timestamp, input.body)
    expect(verifyApprovalWebhookSignature({ ...input, signature })).toBe(true)
    expect(verifyApprovalWebhookSignature({ ...input, body: `${input.body} `, signature })).toBe(false)
  })
})
