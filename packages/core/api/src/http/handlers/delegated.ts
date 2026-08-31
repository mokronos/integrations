import {
  whenPresentMap
} from "@mokronos/contracts"
import { IntegrationsApiService } from "@mokronos/integrations"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { deliverApprovalNotification } from "@mokronos/gateway-core"
import {
  ApprovalId,
  ToolName
} from "@mokronos/gateway-core"
import { invokeThroughGateway, listEffectiveTools } from "@mokronos/gateway-core"
import { GatewayStoreError, GatewayStoreService } from "@mokronos/gateway-core"
import {
  ApiNotFound,
  GatewayApi
} from "../api.ts"
import {
  requireClient,
  requireSecret
} from "../authority.ts"
import {
  GatewayConfig
} from "../services.ts"

const orDieStorage = <A, E, R>(effect: Effect.Effect<A, E | GatewayStoreError, R>) =>
  effect.pipe(Effect.catchTag("GatewayStoreError", Effect.die))

// --- system -----------------------------------------------------------------

export const DelegatedLayer = HttpApiBuilder.group(GatewayApi, "delegated", (handlers) =>
  Effect.gen(function*() {
    const store = yield* GatewayStoreService
    const integrationsApi = yield* IntegrationsApiService
    const config = yield* GatewayConfig
    return handlers
      .handle("listTools", (request) =>
        Effect.gen(function*() {
          const client = yield* requireClient
          return {
            tools: yield* orDieStorage(listEffectiveTools(store, client.id, {
              schemas: request.query["schemas"],
              integrations: integrationsApi
            }))
          }
        }))
      .handle("execute", (request) =>
        Effect.gen(function*() {
          const secret = yield* requireSecret
          return yield* orDieStorage(invokeThroughGateway(
            {
              store,
              integrations: integrationsApi,
              argumentRetentionDays: config.retentionDays,
              approvalUrlOf: (approvalId) => {
                const origin = config.dashboardUrl?.()
                return origin === undefined
                  ? undefined
                  : `${origin.replace(/\/+$/, "")}/approvals?approval=${encodeURIComponent(approvalId)}`
              },
              onApprovalCreated: (input) => deliverApprovalNotification({
                client: input.authorization.client,
                approvalId: input.approvalId,
                alias: input.authorization.binding.alias,
                tool: input.authorization.binding.tool,
                expiresAt: input.expiresAt,
                ...whenPresentMap("approvalUrl", input.approvalUrl, (url) => url)
              })
            },
            {
              secret,
              alias: request.payload.alias,
              tool: ToolName.make(request.payload.tool),
              arguments: request.payload.arguments ?? {}
            }
          ))
        }))
      .handle("approval", (request) =>
        Effect.gen(function*() {
          const id = ApprovalId.make(request.params["id"])
          const client = yield* requireClient
          const approval = yield* orDieStorage(store.getApproval(client.tenantId, id))
          // Scoped to the caller: one client must not read another's frozen call.
          if (approval === undefined || approval.clientId !== client.id) {
            return yield* new ApiNotFound({ error: `Unknown approval ${id}` })
          }
          return approval
        }))
  }))

// --- provisioning -----------------------------------------------------------

/** Picks the auth method a connect request should use, preferring an explicit
 *  template and otherwise the integration's only sensible option. */
