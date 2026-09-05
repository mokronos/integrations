import {
  NonNegativeInt,
  PositiveInt,
  whenPresentMap
} from "@mokronos/contracts"
import { IntegrationsApiService } from "@mokronos/integrations"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import {
  Alias,
  ClientId,
  connectionRefKey,
  type ConnectionRef,
  AccessProfileId,
  ApprovalPolicyId,
  ToolName
} from "@mokronos/gateway-core"
import type { DriftReport } from "@mokronos/gateway-core"
import { refreshIntegrationSnapshot } from "@mokronos/gateway-core"
import {
  approveApproval,
  denyApproval,
  listEffectiveTools,
  reconcileDefaults
} from "@mokronos/gateway-core"
import {
  generateApiKey,
  generateApprovalSigningSecret,
  newAccessProfileId,
  newApprovalDestinationId,
  newApprovalPolicyId,
  newClientId
} from "@mokronos/gateway-core"
import { runMaintenance } from "@mokronos/gateway-core"
import { deliverDueApprovalNotifications } from "@mokronos/gateway-core"
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

const approvalWebhookUrl = (value: string): URL | undefined => {
  try {
    const url = new URL(value)
    const host = url.hostname.toLowerCase()
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return undefined
    if (host === "localhost" || host === "::1" || host === "0.0.0.0" || host.endsWith(".localhost")) return undefined
    if (host.startsWith("127.") || host.startsWith("10.") || host.startsWith("192.168.")) return undefined
    const match = /^172\.(\d+)\./.exec(host)
    if (match?.[1] !== undefined && Number(match[1]) >= 16 && Number(match[1]) <= 31) return undefined
    return url
  } catch {
    return undefined
  }
}

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
      .handle("createConfiguredClient", (request) => Effect.gen(function*() {
        const tenantId = yield* requireTenant
        const { tools } = request.payload
        const name = request.payload.name.trim()
        if (name.length === 0) return yield* new ApiBadRequest({ error: "Choose a client name" })
        const [client, profiles, policies, catalog] = yield* Effect.all([
          orDieStorage(store.findClientByName(tenantId, name)),
          orDieStorage(store.listAccessProfiles(tenantId)),
          orDieStorage(store.listApprovalPolicies(tenantId)),
          Effect.promise(() => integrationsApi.tools.summaries())
        ])
        if (client !== undefined || profiles.some((profile) => profile.name === name) || policies.some((policy) => policy.name === name)) {
          return yield* new ApiBadRequest({ error: `The name ${name} is already in use. Choose another name or use the existing client.` })
        }
        for (const entry of tools) {
          if (entry.connection.owner !== "org" || !catalog.some((tool) => tool.owner === "org"
            && tool.integration === entry.connection.integration && tool.connection === entry.connection.name && tool.name === entry.tool)) {
            return yield* new ApiBadRequest({ error: `The selected tool ${entry.tool} is no longer available. Refresh the connections and try again.` })
          }
        }
        return yield* orDieStorage(store.createConfiguredClient({
          ...request.payload, name, tenantId,
          id: newClientId(), accessProfileId: newAccessProfileId(), approvalPolicyId: newApprovalPolicyId()
        }))
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
      .handle("listApprovalDestinations", () => Effect.gen(function*() {
        const tenantId = yield* requireTenant
        return { destinations: yield* orDieStorage(store.listApprovalDestinations(tenantId)) }
      }))
      .handle("createApprovalDestination", (request) => Effect.gen(function*() {
        const tenantId = yield* requireTenant
        const url = approvalWebhookUrl(request.payload.url)
        if (url === undefined) return yield* new ApiBadRequest({ error: "Webhook URL must be a public HTTPS URL without embedded credentials" })
        const signingSecret = generateApprovalSigningSecret()
        const destination = yield* orDieStorage(store.createApprovalDestination({
          id: newApprovalDestinationId(), tenantId, name: request.payload.name,
          url: url.toString(), signingSecret
        }))
        return { destination, signingSecret }
      }))
      .handle("deleteApprovalDestination", (request) => Effect.gen(function*() {
        const tenantId = yield* requireTenant
        yield* orDieStorage(store.deleteApprovalDestination(tenantId, request.params["id"]))
        return { deleted: true as const }
      }))
      .handle("getClientApprovalDestinations", (request) => Effect.gen(function*() {
        const tenantId = yield* requireTenant
        const client = yield* orDieStorage(store.findClientById(tenantId, request.params["id"]))
        if (client === undefined) return yield* new ApiNotFound({ error: `Unknown client ${request.params["id"]}` })
        return { destinationIds: yield* orDieStorage(store.listClientApprovalDestinationIds(client.id)) }
      }))
      .handle("replaceClientApprovalDestinations", (request) => Effect.gen(function*() {
        const tenantId = yield* requireTenant
        const client = yield* orDieStorage(store.findClientById(tenantId, request.params["id"]))
        if (client === undefined) return yield* new ApiNotFound({ error: `Unknown client ${request.params["id"]}` })
        const available = yield* orDieStorage(store.listApprovalDestinations(tenantId))
        const selected = new Set(request.payload.destinationIds)
        if (available.filter((destination) => selected.has(destination.id)).length !== selected.size) {
          return yield* new ApiBadRequest({ error: "One or more approval destinations do not belong to this tenant" })
        }
        return { destinationIds: yield* orDieStorage(store.replaceClientApprovalDestinations(tenantId, client.id, [...selected])) }
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
      .handle("listApprovalDeliveries", (request) => Effect.gen(function*() {
        const tenantId = yield* requireTenant
        const approval = yield* orDieStorage(store.getApproval(tenantId, request.params["id"]))
        if (approval === undefined) return yield* new ApiNotFound({ error: `Unknown approval ${request.params["id"]}` })
        return { deliveries: yield* orDieStorage(store.listApprovalDeliveries(tenantId, approval.id)) }
      }))
      .handle("approve", (request) => Effect.gen(function*() {
        return yield* orDieStorage(approveApproval(
          { store, integrations: integrationsApi, retentionDays: config.retentionDays },
          { tenantId: yield* requireTenant, id: request.params["id"], decidedBy: yield* decidedBy }
        )).pipe(
          Effect.catchTag("ApprovalNotFound", ({ id }) => new ApiNotFound({ error: `Unknown approval ${id}` })),
          Effect.catchTag("ApprovalConflict", ({ message }) => new ApiBadRequest({ error: message }))
        )
      }))
      .handle("deny", (request) => Effect.gen(function*() {
        return yield* orDieStorage(denyApproval(
          store,
          { tenantId: yield* requireTenant, id: request.params["id"], decidedBy: yield* decidedBy }
        )).pipe(
          Effect.catchTag("ApprovalNotFound", ({ id }) => new ApiNotFound({ error: `Unknown approval ${id}` })),
          Effect.catchTag("ApprovalConflict", ({ message }) => new ApiBadRequest({ error: message }))
        )
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
      .handle("maintenance", () => Effect.gen(function*() {
        const report = yield* orDieStorage(runMaintenance(store))
        yield* orDieStorage(deliverDueApprovalNotifications({
          store,
          ...whenPresentMap("dashboardUrl", config.dashboardUrl?.(), (url) => url)
        }))
        return report
      }))
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
