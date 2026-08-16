import { Schema } from "effect"
import { createGatewayClient, resolveClientConnection } from "@mokronos/integrations-client"
import type { GatewayClient } from "@mokronos/integrations-client"
import type { IntegrationInvoker, IntegrationSource } from "@mokronos/wfkit/integrations"
import { formatIntegrationSource } from "@mokronos/wfkit/integrations"

type Json = typeof Schema.Json.Type

/** The composition root for integrations inside `wf`.
 *
 * It lives here rather than in the authoring package (which must stay
 * host-agnostic) or the client package (which must stay workflow-agnostic).
 * Only the binary that depends on both gets to know they fit together. */
export interface GatewayInvokerOptions {
  readonly client?: GatewayClient
  /** How long to keep retrying a call a human has not decided on yet. */
  readonly approvalPollMs?: number
}

export class GatewayUnavailableError extends Error {}

export class ApprovalPendingError extends Error {
  readonly approvalId: string

  constructor(approvalId: string, source: string) {
    super(
      `${source} is waiting on approval ${approvalId}. The run will retry until it is decided.`
    )
    this.name = "ApprovalPendingError"
    this.approvalId = approvalId
  }
}

/** Resolved lazily and cached, so importing the CLI never reaches for a
 *  gateway and a run started before the daemon can still find it. */
const lazyClient = (provided: GatewayClient | undefined) => {
  let cached = provided
  return async (): Promise<GatewayClient> => {
    if (cached !== undefined) return cached
    const connection = await resolveClientConnection()
    if (connection === undefined) {
      throw new GatewayUnavailableError(
        "No integration gateway configured. Start one with `integrations serve`, or set INTEGRATIONS_URL and INTEGRATIONS_API_KEY."
      )
    }
    cached = createGatewayClient(connection)
    return cached
  }
}

/** Turns a workflow's `{alias, tool}` into a gateway call.
 *
 * Every failure here is thrown rather than returned, which is deliberate:
 * integration steps declare `Schema.Never` in their error channel because these
 * are transient runtime failures the durable engine retries. A daemon restart,
 * or a human who has not decided yet, is a blip a durable run rides out. */
export const createGatewayIntegrationInvoker = (
  options: GatewayInvokerOptions = {}
): IntegrationInvoker => {
  const client = lazyClient(options.client)
  return {
    invoke: async (source: IntegrationSource, input: Json): Promise<Json> => {
      const gateway = await client()
      const outcome = await gateway.execute({
        alias: source.alias,
        tool: source.tool,
        arguments: input
      })
      switch (outcome.status) {
        case "succeeded":
          return outcome.result
        case "pending":
          // Thrown so the step retries. When the human approves, the gateway
          // has already performed the call and the next attempt reads the
          // stored result — the workflow never gains the capability itself.
          throw new ApprovalPendingError(outcome.approvalId, formatIntegrationSource(source))
        case "denied":
          throw new Error(`${formatIntegrationSource(source)} was denied: ${outcome.reason}`)
        case "failed":
          throw new Error(`${formatIntegrationSource(source)} failed: ${outcome.message}`)
      }
    }
  }
}
