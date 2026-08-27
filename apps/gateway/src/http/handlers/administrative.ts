import {
  NonNegativeInt,
  PositiveInt,
  whenPresentMap
} from "@mokronos/contracts"
import { IntegrationsApiService } from "@mokronos/integration-host"
import { Clock, Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import {
  Alias,
  ClientId,
  ConnectionName,
  IntegrationSlug,
  ToolName
} from "../../domain.ts"
import type { DriftReport } from "../../drift.ts"
import { refreshIntegrationSnapshot } from "../../drift.ts"
import { executeAuthorized, listGrantedTools } from "../../invoke.ts"
import {
  generateApiKey,
  newClientId,
  newGrantId
} from "../../keys.ts"
import { runMaintenance } from "../../maintenance.ts"
import { GatewayStoreError, GatewayStoreService } from "../../store.ts"
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

/** Compares connection names the way a human means them. The host stores a
 *  normalised name (`docs-demo` becomes `docsDemo`), and rather than reproduce
 *  that transformation — which belongs to the host and may change — this
 *  compares the parts a separator convention cannot alter. */
const normalizeName = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, "")

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
          return yield* orDieStorage(store.createClient({
            id: newClientId(),
            tenantId,
            name: body.name,
            capabilities: body.capabilities ?? [],
            ...whenPresentMap("approvalDelivery", body.approvalDelivery, (d) => d)
          }))
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
            tools: yield* orDieStorage(listGrantedTools(store, clientId, {
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
      .handle("listGrants", (request) =>
        Effect.map(
          orDieStorage(store.listGrants(request.query["clientId"])),
          (grants) => ({ grants })
        ))
      .handle("createGrant", (request) =>
        Effect.gen(function*() {
          const tenantId = yield* requireTenant
          const body = request.payload
          const clientId = body.clientId
          if ((yield* orDieStorage(store.findClientById(tenantId, clientId))) === undefined) {
            return yield* new ApiNotFound({ error: `Unknown client ${clientId}` })
          }
          if (body.connection.owner === "user") {
            // The wire contract keeps the user tier because that is where the
            // design is going, but nothing can create a user-tier *connection*
            // yet, so such a grant resolves to an address that does not exist.
            // A grant that can only fail at invoke time is worse than a refusal
            // here.
            return yield* new ApiBadRequest({
              error:
                "User-tier connections do not exist yet, so a user-tier grant cannot resolve. Grant against an org connection."
            })
          }
          const summaries = yield* Effect.promise(() =>
            integrationsApi.tools.summaries({ integration: body.connection.integration }))
          const tool = summaries.find((candidate) =>
            candidate.name === body.tool &&
            candidate.owner === "org" &&
            normalizeName(candidate.connection) === normalizeName(body.connection.name)
          )
          if (tool === undefined) {
            return yield* new ApiNotFound({
              error: `Unknown connected tool ${body.connection.integration}/${body.connection.name}/${body.tool}`
            })
          }
          return yield* orDieStorage(store.createGrant({
            id: newGrantId(),
            tenantId,
            clientId,
            alias: body.alias,
            tool: ToolName.make(body.tool),
            connection: {
              owner: "org" as const,
              integration: IntegrationSlug.make(tool.integration),
              name: ConnectionName.make(tool.connection)
            },
            decision: body.decision ?? tool.defaultDecision
          }))
        }))
      .handle("revokeGrant", (request) =>
        Effect.gen(function*() {
          const tenantId = yield* requireTenant
          yield* orDieStorage(store.revokeGrant(tenantId, request.params["id"]))
          return { revoked: true as const }
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
          const grants = yield* orDieStorage(store.listGrants(approval.clientId))
          const grant = grants.find((candidate) => candidate.id === approval.grantId)
          if (client === undefined || client.revokedAt !== null || grant === undefined) {
            yield* orDieStorage(store.settleApproval({
              tenantId,
              id,
              status: "denied",
              decidedBy: by,
              result: null,
              error: "the client or grant was revoked while this call was frozen"
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
              grant,
              connection: grant.connection,
              subject: grant.connection.owner === "user" ? grant.connection.subject : null
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

