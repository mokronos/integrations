import { Schema } from "effect"
import type { ApprovalId, Client } from "./domain.ts"
import { whenPresent } from "@mokronos/contracts"

/** The intentionally sparse outbound contract. Invocation arguments, results,
 * credentials, and human identities never leave through a notification hook. */
export const ApprovalNotification = Schema.Struct({
  version: Schema.Literal(1),
  event: Schema.Literal("approval.pending"),
  approvalId: Schema.String,
  clientId: Schema.String,
  clientName: Schema.String,
  alias: Schema.String,
  tool: Schema.String,
  expiresAt: Schema.String,
  approvalUrl: Schema.optional(Schema.String)
})
export type ApprovalNotification = typeof ApprovalNotification.Type

export interface ApprovalDeliveryInput {
  readonly client: Client
  readonly approvalId: ApprovalId
  readonly alias: string
  readonly tool: string
  readonly expiresAt: Date
  readonly approvalUrl?: string
}

/** Best-effort fan-out. A notification endpoint cannot make an invocation
 * fail or approve it; it only tells another system where a signed-in human can
 * review the frozen call. */
export const deliverApprovalNotification = async (
  input: ApprovalDeliveryInput,
  doFetch: typeof globalThis.fetch = globalThis.fetch
): Promise<void> => {
  if (input.client.approvalDelivery.webhooks.length === 0) return
  const payload = Schema.decodeUnknownSync(ApprovalNotification)({
    version: 1,
    event: "approval.pending",
    approvalId: input.approvalId,
    clientId: input.client.id,
    clientName: input.client.name,
    alias: input.alias,
    tool: input.tool,
    expiresAt: input.expiresAt.toISOString(),
    ...whenPresent("approvalUrl", input.approvalUrl)
  })
  await Promise.allSettled(input.client.approvalDelivery.webhooks.map(async (url) => {
    const response = await doFetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": input.approvalId,
        "x-integrations-event": "approval.pending"
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5_000)
    })
    if (!response.ok) throw new Error(`Approval webhook returned HTTP ${response.status}`)
  }))
}
