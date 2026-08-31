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
  IntegrationSlug,
  PolicyId,
  sameConnectionRef,
  ToolName
} from "@mokronos/gateway-core"
import type { DriftReport } from "@mokronos/gateway-core"
import { refreshIntegrationSnapshot } from "@mokronos/gateway-core"
import {
  ensureDefaultPolicyTools,
  executeAuthorized,
  listEffectiveTools,
  synchronizeAssignedPolicyBindings,
  synchronizeClientBindings
} from "@mokronos/gateway-core"
import {
  generateApiKey,
  newClientId,
  newPolicyId
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
            clients: yield* orDieStorage(store.listClients(tenantId))
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
          const policy = body.policyId === undefined
            ? yield* orDieStorage(ensureDefaultPolicyTools({
              store,
              integrations: integrationsApi,
              tenantId
            }))
            : yield* orDieStorage(store.findPolicy(tenantId, body.policyId))
          if (policy === undefined) {
            return yield* new ApiBadRequest({ error: `Unknown policy ${body.policyId ?? "default"}` })
          }
          const client = yield* orDieStorage(store.createClient({
            id: newClientId(),
            tenantId,
            policyId: policy.id,
            name: body.name,
            capabilities: body.capabilities ?? [],
            ...whenPresentMap("approvalDelivery", body.approvalDelivery, (d) => d)
          }))
          yield* orDieStorage(synchronizeClientBindings({ store, client }))
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
          // someone else. Generating bindings for the client you are
          // provisioning should not require holding its key.
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
      .handle("listPolicies", () =>
        Effect.gen(function*() {
          const tenantId = yield* requireTenant
          const [policies, clients] = yield* Effect.all([
            orDieStorage(store.listPolicies(tenantId)),
            orDieStorage(store.listClients(tenantId))
          ])
          return {
            policies: yield* Effect.forEach(policies, (policy) =>
              Effect.gen(function*() {
                const [integrations, tools] = yield* Effect.all([
                  orDieStorage(store.listPolicyIntegrations(policy.id)),
                  orDieStorage(store.listPolicyTools(policy.id))
                ])
                return {
                  policy,
                  integrationCount: integrations.length,
                  toolCount: tools.length,
                  enabledToolCount: tools.filter((tool) => tool.enabled).length,
                  assignedClientCount: clients.filter((client) => client.policyId === policy.id).length
                }
              }))
          }
        }))
      .handle("getPolicy", (request) =>
        Effect.gen(function*() {
          const tenantId = yield* requireTenant
          const policy = yield* orDieStorage(store.findPolicy(tenantId, request.params["id"]))
          if (policy === undefined) return yield* new ApiNotFound({ error: "Unknown policy" })
          const [integrations, tools, clients] = yield* Effect.all([
            orDieStorage(store.listPolicyIntegrations(policy.id)),
            orDieStorage(store.listPolicyTools(policy.id)),
            orDieStorage(store.listClients(tenantId))
          ])
          return {
            policy,
            integrations,
            tools,
            assignedClients: clients.filter((client) => client.policyId === policy.id)
          }
        }))
      .handle("createPolicy", (request) =>
        Effect.gen(function*() {
          const tenantId = yield* requireTenant
          return yield* orDieStorage(store.createPolicy({
            id: newPolicyId(),
            tenantId,
            name: request.payload.name
          }))
        }))
      .handle("replacePolicyTools", (request) =>
        Effect.gen(function*() {
          const tenantId = yield* requireTenant
          const policy = yield* orDieStorage(store.findPolicy(tenantId, request.params["id"]))
          if (policy === undefined) return yield* new ApiNotFound({ error: "Unknown policy" })
          const deduplicated = new Map<string, {
            readonly connection: ConnectionRef
            readonly tool: ToolName
            readonly enabled: boolean
            readonly decision: "allow" | "require_approval"
          }>()
          const integrations = [...new Set(request.payload.integrations)]
            .map((integration) => IntegrationSlug.make(integration))
          const membership = new Set<IntegrationSlug>(integrations)
          for (const input of request.payload.tools) {
            const integration = IntegrationSlug.make(input.connection.integration)
            if (!membership.has(integration)) {
              return yield* new ApiBadRequest({
                error: `Tool ${input.connection.integration}/${input.tool} has no integration membership`
              })
            }
            const key = `${connectionRefKey(input.connection)}\u0000${input.tool}`
            const existing = deduplicated.get(key)
            deduplicated.set(key, {
              connection: input.connection,
              tool: ToolName.make(input.tool),
              enabled: existing?.enabled === true || input.enabled,
              decision: existing?.decision === "require_approval" || input.decision === "require_approval"
                ? "require_approval"
                : "allow"
            })
          }
          const configuration = yield* orDieStorage(store.replacePolicyConfiguration(policy.id, {
            integrations,
            tools: [...deduplicated.values()]
          }))
          const updated = yield* orDieStorage(store.findPolicy(tenantId, policy.id))
          if (updated === undefined) return yield* new ApiNotFound({ error: "Unknown policy" })
          yield* orDieStorage(synchronizeAssignedPolicyBindings({ store, policy: updated }))
          return { policy: updated, ...configuration }
        }))
      .handle("clonePolicy", (request) =>
        Effect.gen(function*() {
          const tenantId = yield* requireTenant
          const source = yield* orDieStorage(store.findPolicy(tenantId, request.params["id"]))
          if (source === undefined) return yield* new ApiNotFound({ error: "Unknown policy" })
          const policy = yield* orDieStorage(store.createPolicy({
            id: newPolicyId(), tenantId, name: request.payload.name
          }))
          const [sourceIntegrations, sourceTools] = yield* Effect.all([
            orDieStorage(store.listPolicyIntegrations(source.id)),
            orDieStorage(store.listPolicyTools(source.id))
          ])
          const configuration = yield* orDieStorage(store.replacePolicyConfiguration(policy.id, {
            integrations: sourceIntegrations.map((entry) => entry.integration),
            tools: sourceTools.map((tool) => ({
              connection: tool.connection,
              tool: tool.tool,
              enabled: tool.enabled,
              decision: tool.decision
            }))
          }))
          return { policy, ...configuration }
        }))
      .handle("assignPolicy", (request) =>
        Effect.gen(function*() {
          const tenantId = yield* requireTenant
          const clientId = request.params["id"]
          const policyId = PolicyId.make(request.payload.policyId)
          if ((yield* orDieStorage(store.findClientById(tenantId, clientId))) === undefined) {
            return yield* new ApiNotFound({ error: `Unknown client ${clientId}` })
          }
          if ((yield* orDieStorage(store.findPolicy(tenantId, policyId))) === undefined) {
            return yield* new ApiBadRequest({ error: `Policy ${policyId} belongs to another tenant or does not exist` })
          }
          const assigned = yield* orDieStorage(store.assignPolicy(tenantId, clientId, policyId))
          yield* orDieStorage(synchronizeClientBindings({ store, client: assigned }))
          return assigned
        }))
      .handle("listBindings", (request) =>
        Effect.gen(function*() {
          const tenantId = yield* requireTenant
          const clientId = request.params["id"]
          if ((yield* orDieStorage(store.findClientById(tenantId, clientId))) === undefined) {
            return yield* new ApiNotFound({ error: `Unknown client ${clientId}` })
          }
          return { bindings: yield* orDieStorage(store.listBindings(clientId)) }
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
          const binding = yield* orDieStorage(store.findBindingById(approval.clientId, approval.bindingId))
          const policy = yield* orDieStorage(store.findPolicy(tenantId, approval.policyId))
          const policyIntegrations = policy === undefined
            ? []
            : yield* orDieStorage(store.listPolicyIntegrations(policy.id))
          const policyTools = policy === undefined ? [] : yield* orDieStorage(store.listPolicyTools(policy.id))
          const policyTool = binding === undefined ? undefined : policyTools.find((candidate) =>
            candidate.enabled && sameConnectionRef(candidate.connection, binding.connection) &&
              candidate.tool === binding.tool)
          const integrationMember = binding !== undefined && policyIntegrations.some((candidate) =>
            candidate.integration === binding.connection.integration)
          if (client === undefined || client.revokedAt !== null || client.policyId !== approval.policyId
            || binding === undefined || policy === undefined || !integrationMember || policyTool === undefined) {
            yield* orDieStorage(store.settleApproval({
              tenantId,
              id,
              status: "denied",
              decidedBy: by,
              result: null,
              error: "the client policy or binding changed while this call was frozen"
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
              policy,
              policyTool,
              binding,
              connection: binding.connection,
              subject: binding.connection.owner === "user" ? binding.connection.subject : null,
              decision: policyTool.decision
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
