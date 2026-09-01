import {
  NonNegativeInt,
  PositiveInt,
  whenPresentMap
} from "@mokronos/contracts"
import { IntegrationsApiService } from "@mokronos/integrations"
import { Clock, Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import {
  Alias,
  ClientId,
  connectionRefKey,
  type ConnectionRef,
  AccessProfileId,
  ApprovalPolicyId,
  sameConnectionRef,
  ToolName
} from "@mokronos/gateway-core"
import type { DriftReport } from "@mokronos/gateway-core"
import { refreshIntegrationSnapshot } from "@mokronos/gateway-core"
import {
  executeAuthorized,
  listEffectiveTools,
  reconcileDefaults
} from "@mokronos/gateway-core"
import {
  generateApiKey,
  newAccessProfileId,
  newApprovalPolicyId,
  newClientId
} from "@mokronos/gateway-core"
import { runMaintenance } from "@mokronos/gateway-core"
import { GatewayStoreError, GatewayStoreService } from "@mokronos/gateway-core"
import {
  ApiBadRequest,
  ApiNotFound,
  GatewayApi
} from "../api.ts"
import {
  decidedBy,
  requireTenant
} from "../authority.ts"
import {
  GatewayConfig
} from "../services.ts"

const orDieStorage = <A, E, R>(effect: Effect.Effect<A, E | GatewayStoreError, R>) =>
  effect.pipe(Effect.catchTag("GatewayStoreError", Effect.die))

// --- system -----------------------------------------------------------------

export const AdministrativeLayer = HttpApiBuilder.group(GatewayApi, "administrative", (handlers) =>
  Effect.gen(function*() {
    const store = yield* GatewayStoreService
    const integrationsApi = yield* IntegrationsApiService
    const config = yield* GatewayConfig
    return handlers
      .handle("overview", () =>
        Effect.gen(function*() {
          const tenantId = yield* requireTenant
          const [counts, connections, recentActivity] = yield* Effect.all([
            orDieStorage(store.overviewCounts(tenantId)),
            Effect.promise(() => integrationsApi.connections.list()),
            orDieStorage(store.listAudit(tenantId, {
              limit: PositiveInt.make(5),
              offset: NonNegativeInt.make(0)
            }))
          ])
          return { ...counts, connections: connections.length, recentActivity }
        }))
      .handle("listClients", () =>
        Effect.gen(function*() {
          const tenantId = yield* requireTenant
          return {
            clients: yield* orDieStorage(store.listClients(tenantId)),
            ...whenPresentMap("mcpUrl", config.mcpUrl?.(), (url) => url)
          }
        }))
      .handle("createClient", (request) =>
        Effect.gen(function*() {
          const tenantId = yield* requireTenant
          const body = request.payload
          if ((yield* orDieStorage(store.findClientByName(tenantId, body.name))) !== undefined) {
            return yield* new ApiBadRequest({ error: `A client named ${body.name} already exists` })
          }
          // Clients are created inside the caller's partition. There is no way
          // to provision into another tenant over this surface, by design.
          const defaults = yield* orDieStorage(reconcileDefaults({ store, integrations: integrationsApi, tenantId }))
          const accessProfile = body.accessProfileId === undefined
            ? defaults.accessProfile
            : yield* orDieStorage(store.findAccessProfile(tenantId, body.accessProfileId))
          const approvalPolicy = body.approvalPolicyId === undefined
            ? defaults.approvalPolicy
            : yield* orDieStorage(store.findApprovalPolicy(tenantId, body.approvalPolicyId))
          if (accessProfile === undefined) {
            return yield* new ApiBadRequest({ error: `Unknown access profile ${body.accessProfileId ?? "default"}` })
          }
          if (approvalPolicy === undefined) {
            return yield* new ApiBadRequest({ error: `Unknown approval policy ${body.approvalPolicyId ?? "default"}` })
          }
          const client = yield* orDieStorage(store.createClient({
            id: newClientId(),
            tenantId,
            accessProfileId: accessProfile.id,
            approvalPolicyId: approvalPolicy.id,
            name: body.name,
            capabilities: body.capabilities ?? [],
            ...whenPresentMap("approvalDelivery", body.approvalDelivery, (d) => d)
          }))
          return client
        }))
      .handle("updateClientSettings", (request) =>
        Effect.gen(function*() {
          const tenantId = yield* requireTenant
          const clientId = request.params["id"]
          const existing = yield* orDieStorage(store.findClientById(tenantId, clientId))
          if (existing === undefined) {
            return yield* new ApiNotFound({ error: `Unknown client ${clientId}` })
          }
          if (existing.revokedAt !== null) {
            return yield* new ApiBadRequest({ error: `Client ${clientId} is revoked` })
          }
          return yield* orDieStorage(store.updateClientSettings({
            tenantId,
            id: clientId,
            capabilities: request.payload.capabilities,
            approvalDelivery: request.payload.approvalDelivery
          }))
        }))
      .handle("issueKey", (request) =>
        Effect.gen(function*() {
          const tenantId = yield* requireTenant
          const clientId = request.params["id"]
          if ((yield* orDieStorage(store.findClientById(tenantId, clientId))) === undefined) {
            return yield* new ApiNotFound({ error: `Unknown client ${clientId}` })
          }
          const key = generateApiKey()
          yield* orDieStorage(store.addApiKey({ id: key.id, clientId, hash: key.hash }))
          // The only time the plaintext exists outside the caller's hands.
          return { id: key.id, clientId, secret: key.secret }
        }))
      .handle("listKeys", (request) =>
        Effect.gen(function*() {
          const tenantId = yield* requireTenant
          const clientId = request.params["id"]
          if ((yield* orDieStorage(store.findClientById(tenantId, clientId))) === undefined) {
            return yield* new ApiNotFound({ error: `Unknown client ${clientId}` })
          }
          // Hashes stay behind the gateway. What an operator needs is which keys
          // exist, when each was last used, and which are still live.
          const keys = yield* orDieStorage(store.listApiKeys(clientId))
          return {
            keys: keys.map((key) => ({
              id: key.id,
              clientId: key.clientId,
              createdAt: key.createdAt,
              lastUsedAt: key.lastUsedAt,
              revokedAt: key.revokedAt
            }))
          }
        }))
      .handle("revokeKey", (request) =>
        Effect.gen(function*() {
          const keyId = request.params["id"]
          yield* orDieStorage(store.revokeApiKey(keyId))
          // Rotation, not containment: a revoked key's frozen calls stay armed
          // because the client behind them is still trusted. Revoking the
          // client is what cancels those.
          return { revoked: true as const, key: keyId }
        }))
      .handle("clientTools", (request) =>
        Effect.gen(function*() {
          const tenantId = yield* requireTenant
          const clientId = request.params["id"]
          if ((yield* orDieStorage(store.findClientById(tenantId, clientId))) === undefined) {
            return yield* new ApiNotFound({ error: `Unknown client ${clientId}` })
          }
          // The same listing `/v1/tools` gives a key about itself, asked about
          // someone else. Reading what the client you are provisioning can
          // reach should not require holding its key.
          return {
            tools: yield* orDieStorage(listEffectiveTools(store, clientId, {
              schemas: request.query["schemas"],
              integrations: integrationsApi
            }))
          }
        }))
      .handle("revokeClient", (request) =>
        Effect.gen(function*() {
          const tenantId = yield* requireTenant
          const clientId = request.params["id"]
          if ((yield* orDieStorage(store.findClientById(tenantId, clientId))) === undefined) {
            return yield* new ApiNotFound({ error: `Unknown client ${clientId}` })
          }
          yield* orDieStorage(store.revokeClient(tenantId, clientId))
          // Revoking a client is done because something is wrong, so its frozen
          // actions must not stay armed. Revoking a single key does not do this.
          const cancelled = yield* orDieStorage(store.cancelApprovalsForClient(clientId))
          return { revoked: true as const, cancelledApprovals: cancelled }
        }))
      .handle("listAccessProfiles", () =>
        Effect.gen(function*() {
          const tenantId = yield* requireTenant
          const [accessProfiles, clients] = yield* Effect.all([
            orDieStorage(store.listAccessProfiles(tenantId)),
            orDieStorage(store.listClients(tenantId))
          ])
          return { accessProfiles: yield* Effect.forEach(accessProfiles, (accessProfile) => Effect.gen(function*() {
            const tools = yield* orDieStorage(store.listAccessProfileTools(accessProfile.id))
            return { accessProfile, connectionCount: new Set(tools.map((tool) => connectionRefKey(tool.connection))).size,
              integrationCount: new Set(tools.map((tool) => tool.connection.integration)).size, toolCount: tools.length,
              assignedClientCount: clients.filter((client) => client.accessProfileId === accessProfile.id).length }
          })) }
        }))
      .handle("getAccessProfile", (request) =>
        Effect.gen(function*() {
          const tenantId = yield* requireTenant
          const accessProfile = yield* orDieStorage(store.findAccessProfile(tenantId, request.params["id"]))
          if (accessProfile === undefined) return yield* new ApiNotFound({ error: "Unknown access profile" })
          const [tools, clients] = yield* Effect.all([
            orDieStorage(store.listAccessProfileTools(accessProfile.id)),
            orDieStorage(store.listClients(tenantId))
          ])
          return { accessProfile, tools, assignedClients: clients.filter((client) => client.accessProfileId === accessProfile.id) }
        }))
      .handle("createAccessProfile", (request) =>
        Effect.gen(function*() {
          const tenantId = yield* requireTenant
          return yield* orDieStorage(store.createAccessProfile({ id: newAccessProfileId(), tenantId, name: request.payload.name }))
        }))
      .handle("updateAccessProfile", (request) => Effect.gen(function*() {
        const tenantId = yield* requireTenant
        if ((yield* orDieStorage(store.findAccessProfile(tenantId, request.params["id"]))) === undefined) return yield* new ApiNotFound({ error: "Unknown access profile" })
        return yield* orDieStorage(store.updateAccessProfile(tenantId, request.params["id"], request.payload.name))
      }))
      .handle("deleteAccessProfile", (request) => Effect.gen(function*() {
        const tenantId = yield* requireTenant
        const profile = yield* orDieStorage(store.findAccessProfile(tenantId, request.params["id"]))
        if (profile === undefined) return yield* new ApiNotFound({ error: "Unknown access profile" })
        if (profile.isDefault) return yield* new ApiBadRequest({ error: "The default access profile cannot be deleted" })
        yield* orDieStorage(store.deleteAccessProfile(tenantId, profile.id))
        return { deleted: true as const }
      }))
      .handle("replaceAccessProfileTools", (request) =>
        Effect.gen(function*() {
          const tenantId = yield* requireTenant
          const accessProfile = yield* orDieStorage(store.findAccessProfile(tenantId, request.params["id"]))
          if (accessProfile === undefined) return yield* new ApiNotFound({ error: "Unknown access profile" })
          const deduplicated = new Map<string, { readonly connection: ConnectionRef; readonly tool: ToolName }>()
          for (const input of request.payload.tools) {
            const key = `${connectionRefKey(input.connection)}\u0000${input.tool}`
            deduplicated.set(key, { connection: input.connection, tool: ToolName.make(input.tool) })
          }
          const tools = yield* orDieStorage(store.replaceAccessProfileTools(accessProfile.id, [...deduplicated.values()]))
          return { accessProfile: yield* orDieStorage(store.findAccessProfile(tenantId, accessProfile.id)).pipe(Effect.flatMap((v) => v === undefined ? new ApiNotFound({ error: "Unknown access profile" }) : Effect.succeed(v))), tools }
        }))
      .handle("cloneAccessProfile", (request) =>
        Effect.gen(function*() {
          const tenantId = yield* requireTenant
          const source = yield* orDieStorage(store.findAccessProfile(tenantId, request.params["id"]))
          if (source === undefined) return yield* new ApiNotFound({ error: "Unknown access profile" })
          const accessProfile = yield* orDieStorage(store.createAccessProfile({ id: newAccessProfileId(), tenantId, name: request.payload.name }))
          const sourceTools = yield* orDieStorage(store.listAccessProfileTools(source.id))
          const tools = yield* orDieStorage(store.replaceAccessProfileTools(accessProfile.id, sourceTools.map(({ connection, tool }) => ({ connection, tool }))))
          return { accessProfile, tools }
        }))
      .handle("assignAccessProfile", (request) =>
        Effect.gen(function*() {
          const tenantId = yield* requireTenant
          const clientId = request.params["id"]
          if ((yield* orDieStorage(store.findClientById(tenantId, clientId))) === undefined) {
            return yield* new ApiNotFound({ error: `Unknown client ${clientId}` })
          }
          const id = AccessProfileId.make(request.payload.accessProfileId)
          if ((yield* orDieStorage(store.findAccessProfile(tenantId, id))) === undefined) {
            return yield* new ApiBadRequest({ error: `Access profile ${id} belongs to another tenant or does not exist` })
          }
          return yield* orDieStorage(store.assignAccessProfile(tenantId, clientId, id))
        }))
      .handle("listApprovalPolicies", () =>
        Effect.gen(function*() {
          const tenantId = yield* requireTenant
          const [approvalPolicies, clients] = yield* Effect.all([orDieStorage(store.listApprovalPolicies(tenantId)), orDieStorage(store.listClients(tenantId))])
          return { approvalPolicies: yield* Effect.forEach(approvalPolicies, (approvalPolicy) => Effect.gen(function*() {
            const tools = yield* orDieStorage(store.listApprovalPolicyTools(approvalPolicy.id))
            return { approvalPolicy, connectionCount: new Set(tools.map((tool) => connectionRefKey(tool.connection))).size,
              integrationCount: new Set(tools.map((tool) => tool.connection.integration)).size, toolCount: tools.length,
              assignedClientCount: clients.filter((client) => client.approvalPolicyId === approvalPolicy.id).length }
          })) }
        }))
      .handle("getApprovalPolicy", (request) => Effect.gen(function*() {
        const tenantId = yield* requireTenant
        const approvalPolicy = yield* orDieStorage(store.findApprovalPolicy(tenantId, request.params["id"]))
        if (approvalPolicy === undefined) return yield* new ApiNotFound({ error: "Unknown approval policy" })
        const [tools, clients] = yield* Effect.all([orDieStorage(store.listApprovalPolicyTools(approvalPolicy.id)), orDieStorage(store.listClients(tenantId))])
        return { approvalPolicy, tools, assignedClients: clients.filter((client) => client.approvalPolicyId === approvalPolicy.id) }
      }))
      .handle("createApprovalPolicy", (request) => Effect.gen(function*() {
        const tenantId = yield* requireTenant
        return yield* orDieStorage(store.createApprovalPolicy({ id: newApprovalPolicyId(), tenantId, name: request.payload.name }))
      }))
      .handle("updateApprovalPolicy", (request) => Effect.gen(function*() {
        const tenantId = yield* requireTenant
        if ((yield* orDieStorage(store.findApprovalPolicy(tenantId, request.params["id"]))) === undefined) return yield* new ApiNotFound({ error: "Unknown approval policy" })
        return yield* orDieStorage(store.updateApprovalPolicy(tenantId, request.params["id"], request.payload.name))
      }))
      .handle("deleteApprovalPolicy", (request) => Effect.gen(function*() {
        const tenantId = yield* requireTenant
        const policy = yield* orDieStorage(store.findApprovalPolicy(tenantId, request.params["id"]))
        if (policy === undefined) return yield* new ApiNotFound({ error: "Unknown approval policy" })
        if (policy.isDefault) return yield* new ApiBadRequest({ error: "The default approval policy cannot be deleted" })
        yield* orDieStorage(store.deleteApprovalPolicy(tenantId, policy.id)); return { deleted: true as const }
      }))
      .handle("replaceApprovalPolicyTools", (request) => Effect.gen(function*() {
        const tenantId = yield* requireTenant
        const approvalPolicy = yield* orDieStorage(store.findApprovalPolicy(tenantId, request.params["id"]))
        if (approvalPolicy === undefined) return yield* new ApiNotFound({ error: "Unknown approval policy" })
        const deduplicated = new Map<string, { readonly connection: ConnectionRef; readonly tool: ToolName; readonly decision: "allow" | "require_approval" }>()
        for (const input of request.payload.tools) {
          const key = `${connectionRefKey(input.connection)}\u0000${input.tool}`
          const existing = deduplicated.get(key)
          deduplicated.set(key, { connection: input.connection, tool: ToolName.make(input.tool), decision: existing?.decision === "require_approval" || input.decision === "require_approval" ? "require_approval" : "allow" })
        }
        const tools = yield* orDieStorage(store.replaceApprovalPolicyTools(approvalPolicy.id, [...deduplicated.values()]))
        return { approvalPolicy: yield* orDieStorage(store.findApprovalPolicy(tenantId, approvalPolicy.id)).pipe(Effect.flatMap((v) => v === undefined ? new ApiNotFound({ error: "Unknown approval policy" }) : Effect.succeed(v))), tools }
      }))
      .handle("cloneApprovalPolicy", (request) => Effect.gen(function*() {
        const tenantId = yield* requireTenant
        const source = yield* orDieStorage(store.findApprovalPolicy(tenantId, request.params["id"]))
        if (source === undefined) return yield* new ApiNotFound({ error: "Unknown approval policy" })
        const approvalPolicy = yield* orDieStorage(store.createApprovalPolicy({ id: newApprovalPolicyId(), tenantId, name: request.payload.name }))
        const sourceTools = yield* orDieStorage(store.listApprovalPolicyTools(source.id))
        const tools = yield* orDieStorage(store.replaceApprovalPolicyTools(approvalPolicy.id, sourceTools.map(({ connection, tool, decision }) => ({ connection, tool, decision }))))
        return { approvalPolicy, tools }
      }))
      .handle("assignApprovalPolicy", (request) => Effect.gen(function*() {
        const tenantId = yield* requireTenant
        const clientId = request.params["id"]
        if ((yield* orDieStorage(store.findClientById(tenantId, clientId))) === undefined) return yield* new ApiNotFound({ error: `Unknown client ${clientId}` })
        const id = ApprovalPolicyId.make(request.payload.approvalPolicyId)
        if ((yield* orDieStorage(store.findApprovalPolicy(tenantId, id))) === undefined) return yield* new ApiBadRequest({ error: `Approval policy ${id} belongs to another tenant or does not exist` })
        return yield* orDieStorage(store.assignApprovalPolicy(tenantId, clientId, id))
      }))
      .handle("listApprovals", (request) =>
        Effect.gen(function*() {
          const tenantId = yield* requireTenant
          const status = request.query["status"]
          return {
            approvals: yield* orDieStorage(
              status === undefined
                ? store.listApprovals(tenantId)
                : store.listApprovals(tenantId, status))
          }
        }))
      .handle("approve", (request) =>
        Effect.gen(function*() {
          const tenantId = yield* requireTenant
          const id = request.params["id"]
          const by = yield* decidedBy
          const approval = yield* orDieStorage(store.getApproval(tenantId, id))
          if (approval === undefined) {
            return yield* new ApiNotFound({ error: `Unknown approval ${id}` })
          }
          if (approval.status !== "pending") {
            return yield* new ApiBadRequest({ error: `Approval ${id} is already ${approval.status}` })
          }
          const now = yield* Clock.currentTimeMillis
          if (approval.expiresAt.getTime() <= now) {
            yield* orDieStorage(store.settleApproval({
              tenantId,
              id,
              status: "expired",
              decidedBy: null,
              result: null,
              error: "expired before a decision was recorded"
            }))
            // Expiry is a decision, not an absence of one.
            return yield* new ApiBadRequest({ error: `Approval ${id} expired` })
          }

          const client = yield* orDieStorage(store.findClientById(tenantId, approval.clientId))
          const accessProfile = yield* orDieStorage(store.findAccessProfile(tenantId, approval.accessProfileId))
          const approvalPolicy = yield* orDieStorage(store.findApprovalPolicy(tenantId, approval.approvalPolicyId))
          const accessTools = accessProfile === undefined ? [] : yield* orDieStorage(store.listAccessProfileTools(accessProfile.id))
          const approvalTools = approvalPolicy === undefined ? [] : yield* orDieStorage(store.listApprovalPolicyTools(approvalPolicy.id))
          const accessProfileTool = accessTools.find((candidate) => candidate.tool === approval.tool)
          const approvalPolicyTool = accessProfileTool === undefined ? undefined : approvalTools.find((candidate) =>
            candidate.tool === approval.tool && sameConnectionRef(candidate.connection, accessProfileTool.connection))
          if (client === undefined || client.revokedAt !== null
            || client.accessProfileId !== approval.accessProfileId
            || client.approvalPolicyId !== approval.approvalPolicyId
            || accessProfile === undefined || approvalPolicy === undefined
            || accessProfileTool === undefined || approvalPolicyTool === undefined) {
            yield* orDieStorage(store.settleApproval({
              tenantId,
              id,
              status: "denied",
              decidedBy: by,
              result: null,
              error: "the client assignments or tool intersection changed while this call was frozen"
            }))
            return yield* new ApiBadRequest({ error: `Approval ${id} is no longer authorized` })
          }

          // The gateway performs the call. The caller is never handed the
          // ability to perform it, so approving confers no capability.
          const outcome = yield* orDieStorage(executeAuthorized(
            {
              store,
              integrations: integrationsApi,
              retentionDays: config.retentionDays
            },
            {
              status: "authorized",
              client,
              accessProfile,
              accessProfileTool,
              approvalPolicy,
              approvalPolicyTool,
              alias: approval.alias,
              connection: accessProfileTool.connection,
              subject: accessProfileTool.connection.owner === "user" ? accessProfileTool.connection.subject : null,
              decision: approvalPolicyTool.decision
            },
            approval.arguments
          ))
          yield* orDieStorage(store.settleApproval({
            tenantId,
            id,
            status: "approved",
            decidedBy: by,
            result: outcome.status === "succeeded" ? outcome.result : null,
            error: outcome.status === "failed" ? outcome.message : null
          }))
          const settled = yield* orDieStorage(store.getApproval(tenantId, id))
          if (settled === undefined) {
            return yield* new ApiNotFound({ error: `Unknown approval ${id}` })
          }
          if (outcome.status === "succeeded") {
            return {
              approval: settled,
              outcome: { status: "succeeded" as const, result: outcome.result }
            }
          }
          if (outcome.status === "failed") {
            return {
              approval: settled,
              outcome: { status: "failed" as const, message: outcome.message }
            }
          }
          // Unreachable through this path — settlement runs an authorized call,
          // which never freezes or denies — but the type stays honest.
          return yield* new ApiBadRequest({
            error: "Approval settled without a performed call"
          })
        }))
      .handle("deny", (request) =>
        Effect.gen(function*() {
          const tenantId = yield* requireTenant
          const id = request.params["id"]
          const by = yield* decidedBy
          const approval = yield* orDieStorage(store.getApproval(tenantId, id))
          if (approval === undefined) {
            return yield* new ApiNotFound({ error: `Unknown approval ${id}` })
          }
          yield* orDieStorage(store.settleApproval({
            tenantId,
            id,
            status: "denied",
            decidedBy: by,
            result: null,
            error: null
          }))
          const settled = yield* orDieStorage(store.getApproval(tenantId, id))
          if (settled === undefined) {
            return yield* new ApiNotFound({ error: `Unknown approval ${id}` })
          }
          return { approval: settled }
        }))
      .handle("refreshDrift", (request) =>
        Effect.gen(function*() {
          const tenantId = yield* requireTenant
          const slug = request.query["integration"]
          const slugs = slug === undefined
            ? (yield* Effect.promise(() => integrationsApi.catalog.list()))
              .map((entry) => entry.slug)
            : [slug]
          const reports: Array<DriftReport> = []
          for (const integration of slugs) {
            reports.push(yield* refreshIntegrationSnapshot(
              { store: store, integrations: integrationsApi },
              integration,
              tenantId
            ).pipe(Effect.orDie))
          }
          return { reports }
        }))
      .handle("maintenance", () => orDieStorage(runMaintenance(store)))
      .handle("audit", (request) =>
        Effect.gen(function*() {
          const tenantId = yield* requireTenant
          const query = request.query
          const filter = {
            ...whenPresentMap("clientId", query["clientId"], ClientId.make),
            ...whenPresentMap("alias", query["alias"], Alias.make),
            ...whenPresentMap(
              "tool",
              query["tool"] === undefined ? undefined : ToolName.make(query["tool"]),
              (tool) => tool
            ),
            ...whenPresentMap("outcome", query["outcome"], (o) => o),
            ...whenPresentMap("since", query["since"], (since) => since)
          }
          const limit = query["limit"]
          const offset = query["offset"]
          // The trail is permanent, so the count is what tells a reader whether
          // the window they asked for is the whole answer.
          return {
            records: yield* orDieStorage(store.listAudit(tenantId, { ...filter, limit, offset })),
            total: yield* orDieStorage(store.countAudit(tenantId, filter)),
            limit,
            offset
          }
        }))
  }))

// --- auth -------------------------------------------------------------------
