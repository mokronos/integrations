import {
  whenPresent,
  whenPresentMap
} from "@integrations/contracts"
import { BlobStore, Integrations } from "@integrations/integrations"
import { Effect, Stream } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { deliverDueApprovalNotifications } from "@integrations/gateway-core"
import {
  ApprovalId,
  BlobId,
  blobHandleKey,
  ToolName
} from "@integrations/contracts"
import { invokeThroughGateway, listEffectiveTools } from "@integrations/gateway-core"
import { GatewayStoreService } from "@integrations/gateway-core"
import {
  ApiNotFound,
  GatewayApi
} from "../api.ts"
import {
  requireClient,
  requireSecret
} from "../authority.ts"
import {
  GatewayConfig,
  OAuthFlowSessions
} from "../services.ts"
import { capture } from "../observability.ts"

export const DelegatedLayer = HttpApiBuilder.group(GatewayApi, "delegated", (handlers) =>
  Effect.gen(function*() {
    const store = yield* GatewayStoreService
    const integrations = yield* Integrations
    const blobs = yield* BlobStore
    const config = yield* GatewayConfig
    const oauth = yield* OAuthFlowSessions
    return handlers
      .handle("listTools", (request) =>
        Effect.gen(function*() {
          const client = yield* requireClient
          return {
            tools: yield* capture(listEffectiveTools(store, client.id, {
              schemas: request.query["schemas"],
              integrations,
              ...whenPresentMap("integration", request.query["integration"], (integration) => integration),
              ...whenPresentMap("connection", request.query["connection"], (connection) => connection)
            }))
          }
        }))
      .handle("execute", (request) =>
        Effect.gen(function*() {
          const secret = yield* requireSecret
          return yield* capture(invokeThroughGateway(
            {
              store,
              integrations,
              oauth,
              argumentRetentionDays: config.retentionDays,
              approvalUrlOf: (approvalId) => {
                const origin = config.dashboardUrl?.()
                return origin === undefined
                  ? undefined
                  : `${origin.replace(/\/+$/, "")}/approvals?approval=${encodeURIComponent(approvalId)}`
              },
              onApprovalCreated: () => capture(deliverDueApprovalNotifications({
                store,
                ...whenPresentMap("dashboardUrl", config.dashboardUrl?.(), (url) => url)
              }))
            },
            {
              secret,
              alias: request.payload.alias,
              tool: ToolName.make(request.payload.tool),
              arguments: request.payload.arguments ?? {},
              ...whenPresent("subject", request.payload.subject)
            }
          ))
        }))
      .handle("blob", (request) =>
        Effect.gen(function*() {
          const id = BlobId.make(request.params["id"])
          const opened = yield* blobs.open(id).pipe(
            Effect.mapError(() => new ApiNotFound({ error: `Unknown blob ${id}` }))
          )
          return opened.content
        }))
      .handle("uploadBlob", (request) =>
        Effect.gen(function*() {
          const stored = yield* capture(blobs.write(
            {
              contentType: request.headers["x-blob-content-type"] ?? "application/octet-stream",
              filename: request.headers["x-blob-filename"]
            },
            Stream.succeed(request.payload)
          ))
          return {
            [blobHandleKey]: stored.id,
            bytes: stored.bytes,
            contentType: stored.contentType,
            sha256: stored.sha256
          }
        }))
      .handle("approval", (request) =>
        Effect.gen(function*() {
          const id = ApprovalId.make(request.params["id"])
          const client = yield* requireClient
          const approval = yield* capture(store.getApproval(client.tenantId, id))
          if (approval === undefined || approval.clientId !== client.id) {
            return yield* new ApiNotFound({ error: `Unknown approval ${id}` })
          }
          return approval
        }))
  }))
