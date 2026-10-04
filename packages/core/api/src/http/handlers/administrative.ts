import {
  NonNegativeInt,
  patternProblem,
  PositiveInt,
  whenPresentMap,
  type ApprovalRuleId
} from "@integragents/contracts"
import { BlobStore, Integrations } from "@integragents/host"
import { Duration, Effect, Stream } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import {
  Alias,
  connectionRefKey,
  ProfileId,
  ToolName,
  type ProfileToolInput,
  type TenantId
} from "@integragents/contracts"
import type { DriftReport } from "@integragents/gateway-core"
import { refreshIntegrationSnapshot } from "@integragents/gateway-core"
import {
  approveApproval,
  catalogProfileTools,
  decideApprovals,
  denyApproval,
  listEffectiveTools
} from "@integragents/gateway-core"
import {
  generateApiKey,
  generateApprovalSigningSecret,
  newApprovalDestinationId,
  newProfileId,
  newSubjectId
} from "@integragents/gateway-core"
import { runMaintenance } from "@integragents/gateway-core"
import { deliverDueApprovalNotifications } from "@integragents/gateway-core"
import { GatewayEvents, GatewayStoreService } from "@integragents/gateway-core"
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
import { capture } from "../observability.ts"

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

/** Under Bun's ten-second idle timeout, and often enough for a client to notice a dead stream. */
const heartbeatInterval = Duration.seconds(5)

/** One invocation writes an approval, an audit record, and a delivery within milliseconds; the dashboard reloads once. */
const burstWindow = Duration.millis(100)

export const AdministrativeLayer = HttpApiBuilder.group(GatewayApi, "administrative", (handlers) =>
  Effect.gen(function*() {
    const store = yield* GatewayStoreService
    const integrations = yield* Integrations
    const blobs = yield* BlobStore
    const config = yield* GatewayConfig
    const events = yield* GatewayEvents
    const ownedApprovalRule = (id: ApprovalRuleId) => Effect.gen(function*() {
      const tenantId = yield* requireTenant
      const rule = yield* capture(store.findApprovalRule(id))
      const profile = rule === undefined ? undefined : yield* capture(store.findProfileById(tenantId, rule.profileId))
      if (rule === undefined || profile === undefined) return yield* new ApiNotFound({ error: `Unknown approval rule ${id}` })
      return rule
    })
    const requireProfile = (tenantId: TenantId, id: ProfileId) => Effect.gen(function*() {
      const profile = yield* capture(store.findProfileById(tenantId, id))
      if (profile === undefined) return yield* new ApiNotFound({ error: `Unknown profile ${id}` })
      return profile
    })
    const liveProfile = (tenantId: TenantId, id: ProfileId) => Effect.gen(function*() {
      const profile = yield* requireProfile(tenantId, id)
      if (profile.revokedAt !== null) return yield* new ApiBadRequest({ error: `Profile ${profile.name} is revoked` })
      return profile
    })
    const freeName = (tenantId: TenantId, name: string, self?: ProfileId) => Effect.gen(function*() {
      const trimmed = name.trim()
      if (trimmed.length === 0) return yield* new ApiBadRequest({ error: "A profile needs a name" })
      const taken = yield* capture(store.findProfileByName(tenantId, trimmed))
      if (taken !== undefined && taken.id !== self) {
        return yield* new ApiBadRequest({ error: `A profile named ${trimmed} already exists` })
      }
      return trimmed
    })
    /** One row per route, each naming an org tool the gateway still reaches or a delegation template. */
    const checkedTools = (tools: ReadonlyArray<ProfileToolInput>) => Effect.gen(function*() {
      const catalog = new Set((yield* capture(catalogProfileTools(integrations)))
        .map((entry) => `${connectionRefKey(entry.connection)}\u0000${entry.tool}`))
      const routes = new Map<string, ProfileToolInput>()
      for (const entry of tools) {
        const key = `${connectionRefKey(entry.connection)}\u0000${entry.tool}`
        if (entry.connection.owner === "org" && !catalog.has(key)) {
          return yield* new ApiBadRequest({ error: `${entry.connection.integration}/${entry.connection.name} has no tool ${entry.tool}. Refresh the connections and try again.` })
        }
        routes.set(key, { connection: entry.connection, tool: ToolName.make(entry.tool), decision: entry.decision })
      }
      return [...routes.values()]
    })
    return handlers
      .handle("events", () =>
        Effect.map(requireTenant, (tenantId) =>
          Stream.unwrap(Effect.map(events.subscribe(tenantId), (changes) =>
            Stream.concat(
              Stream.make({ _tag: "Connected" as const }),
              Stream.merge(
                changes.pipe(
                  Stream.groupedWithin(64, burstWindow),
                  Stream.flatMap((burst) => Stream.fromIterable(new Set(burst))),
                  Stream.map((resource) => ({ _tag: "Changed" as const, resource }))
                ),
                Stream.map(Stream.tick(heartbeatInterval), () => ({ _tag: "Heartbeat" as const }))
              )
            )))))
      .handle("overview", () =>
        Effect.gen(function*() {
          const tenantId = yield* requireTenant
          const [counts, connections, recentActivity] = yield* Effect.all([
            capture(store.overviewCounts(tenantId)),
            capture(integrations.listConnections()),
            capture(store.listAudit(tenantId, {
              limit: PositiveInt.make(5),
              offset: NonNegativeInt.make(0)
            }))
          ])
          return { ...counts, connections: connections.length, recentActivity }
        }))
      .handle("listSubjects", () =>
        Effect.gen(function*() {
          const tenantId = yield* requireTenant
          return { subjects: yield* capture(store.listSubjects(tenantId)) }
        }))
      .handle("createSubject", (request) =>
        Effect.gen(function*() {
          const tenantId = yield* requireTenant
          const id = request.payload.id ?? (yield* newSubjectId)
          if ((yield* capture(store.findSubjectById(id))) !== undefined) {
            return yield* new ApiBadRequest({ error: `Subject ${id} already exists` })
          }
          return yield* capture(store.createSubject({ id, tenantId }))
        }))
      .handle("listProfiles", () =>
        Effect.gen(function*() {
          const tenantId = yield* requireTenant
          const [profiles, grants] = yield* Effect.all([
            capture(store.listProfiles(tenantId)),
            capture(store.listOAuthGrants(tenantId))
          ])
          return {
            profiles: yield* Effect.forEach(profiles, (profile) => Effect.gen(function*() {
              const [tools, keys] = yield* Effect.all([
                capture(store.listProfileTools(profile.id)),
                capture(store.listApiKeys(profile.id))
              ])
              return {
                profile,
                tools: tools.length,
                approvalTools: tools.filter((tool) => tool.decision === "require_approval").length,
                keys: keys.filter((key) => key.revokedAt === null).length,
                applications: grants.filter((grant) => grant.profileId === profile.id && grant.revokedAt === null).length
              }
            })),
            ...whenPresentMap("gatewayUrl", config.dashboardUrl?.(), (url) => url),
            ...whenPresentMap("mcpUrl", config.mcpUrl?.(), (url) => url)
          }
        }))
      .handle("createProfile", (request) => Effect.gen(function*() {
        const tenantId = yield* requireTenant
        const body = request.payload
        const name = yield* freeName(tenantId, body.name)
        const source = body.copyFrom === undefined ? undefined : yield* requireProfile(tenantId, body.copyFrom)
        const tools = body.tools !== undefined
          ? yield* checkedTools(body.tools)
          : source === undefined ? [] : yield* capture(store.listProfileTools(source.id))
        return yield* capture(store.createProfile({
          id: yield* newProfileId,
          tenantId,
          name,
          tools,
          capabilities: body.capabilities ?? source?.capabilities ?? [],
          ...whenPresentMap("approvalMethod", body.approvalMethod ?? source?.approvalMethod, (method) => method),
          ...whenPresentMap("mcpSurface", body.mcpSurface ?? source?.mcpSurface, (surface) => surface),
          ...whenPresentMap(
            "approvalGroupWindowMinutes",
            body.approvalGroupWindowMinutes ?? source?.approvalGroupWindowMinutes,
            (minutes) => minutes
          ),
          ...whenPresentMap("includeNewTools", body.includeNewTools ?? source?.includeNewTools, (include) => include),
          ...whenPresentMap(
            "destinationIds",
            source === undefined ? undefined : yield* capture(store.listProfileApprovalDestinationIds(source.id)),
            (ids) => ids
          )
        }))
      }))
      .handle("renameProfile", (request) =>
        Effect.gen(function*() {
          const tenantId = yield* requireTenant
          const profile = yield* liveProfile(tenantId, request.params["id"])
          const name = yield* freeName(tenantId, request.payload.name, profile.id)
          return yield* capture(store.renameProfile(tenantId, profile.id, name))
        }))
      .handle("updateProfileSettings", (request) =>
        Effect.gen(function*() {
          const tenantId = yield* requireTenant
          const profile = yield* liveProfile(tenantId, request.params["id"])
          return yield* capture(store.updateProfileSettings(tenantId, profile.id, request.payload))
        }))
      .handle("profileTools", (request) =>
        Effect.gen(function*() {
          const tenantId = yield* requireTenant
          const profile = yield* requireProfile(tenantId, request.params["id"])
          return {
            tools: yield* capture(listEffectiveTools(store, profile.id, {
              schemas: request.query["schemas"],
              integrations
            }))
          }
        }))
      .handle("replaceProfileTools", (request) =>
        Effect.gen(function*() {
          const tenantId = yield* requireTenant
          const profile = yield* liveProfile(tenantId, request.params["id"])
          const tools = yield* checkedTools(request.payload.tools)
          return { tools: yield* capture(store.replaceProfileTools(profile.id, tools)) }
        }))
      .handle("listApprovalRules", (request) =>
        Effect.gen(function*() {
          const tenantId = yield* requireTenant
          const profile = yield* requireProfile(tenantId, request.params["id"])
          return { rules: yield* capture(store.listApprovalRules(profile.id)) }
        }))
      .handle("updateApprovalRule", (request) => Effect.gen(function*() {
        const rule = yield* ownedApprovalRule(request.params["id"])
        const problem = patternProblem(request.payload)
        if (problem !== undefined) return yield* new ApiBadRequest({ error: problem })
        return yield* capture(store.updateApprovalRule(rule.id, request.payload))
      }))
      .handle("deleteApprovalRule", (request) => Effect.gen(function*() {
        const rule = yield* ownedApprovalRule(request.params["id"])
        yield* capture(store.deleteApprovalRule(rule.id))
        return { deleted: true as const }
      }))
      .handle("listApprovalDestinations", () => Effect.gen(function*() {
        const tenantId = yield* requireTenant
        return { destinations: yield* capture(store.listApprovalDestinations(tenantId)) }
      }))
      .handle("createApprovalDestination", (request) => Effect.gen(function*() {
        const tenantId = yield* requireTenant
        const url = approvalWebhookUrl(request.payload.url)
        if (url === undefined) return yield* new ApiBadRequest({ error: "Webhook URL must be a public HTTPS URL without embedded credentials" })
        const signingSecret = (yield* generateApprovalSigningSecret)
        const destination = yield* capture(store.createApprovalDestination({
          id: (yield* newApprovalDestinationId), tenantId, name: request.payload.name,
          url: url.toString(), signingSecret
        }))
        return { destination, signingSecret }
      }))
      .handle("deleteApprovalDestination", (request) => Effect.gen(function*() {
        const tenantId = yield* requireTenant
        yield* capture(store.deleteApprovalDestination(tenantId, request.params["id"]))
        return { deleted: true as const }
      }))
      .handle("getProfileApprovalDestinations", (request) => Effect.gen(function*() {
        const tenantId = yield* requireTenant
        const profile = yield* requireProfile(tenantId, request.params["id"])
        return { destinationIds: yield* capture(store.listProfileApprovalDestinationIds(profile.id)) }
      }))
      .handle("replaceProfileApprovalDestinations", (request) => Effect.gen(function*() {
        const tenantId = yield* requireTenant
        const profile = yield* liveProfile(tenantId, request.params["id"])
        const available = yield* capture(store.listApprovalDestinations(tenantId))
        const selected = new Set(request.payload.destinationIds)
        if (available.filter((destination) => selected.has(destination.id)).length !== selected.size) {
          return yield* new ApiBadRequest({ error: "One or more approval destinations do not belong to this tenant" })
        }
        return { destinationIds: yield* capture(store.replaceProfileApprovalDestinations(tenantId, profile.id, [...selected])) }
      }))
      .handle("issueKey", (request) =>
        Effect.gen(function*() {
          const tenantId = yield* requireTenant
          const profile = yield* liveProfile(tenantId, request.params["id"])
          const name = request.payload.name.trim()
          if (name.length === 0) return yield* new ApiBadRequest({ error: "Name the key after the app that will use it" })
          const key = (yield* generateApiKey)
          yield* capture(store.addApiKey({ id: key.id, profileId: profile.id, name, hash: key.hash }))
          return { id: key.id, profileId: profile.id, name, secret: key.secret }
        }))
      .handle("listKeys", (request) =>
        Effect.gen(function*() {
          const tenantId = yield* requireTenant
          const profile = yield* requireProfile(tenantId, request.params["id"])
          const keys = yield* capture(store.listApiKeys(profile.id))
          return {
            keys: keys.map((key) => ({
              id: key.id,
              profileId: key.profileId,
              name: key.name,
              createdAt: key.createdAt,
              lastUsedAt: key.lastUsedAt,
              revokedAt: key.revokedAt
            }))
          }
        }))
      .handle("revokeKey", (request) =>
        Effect.gen(function*() {
          const keyId = request.params["id"]
          yield* capture(store.revokeApiKey(keyId))
          return { revoked: true as const, key: keyId }
        }))
      .handle("revokeProfile", (request) =>
        Effect.gen(function*() {
          const tenantId = yield* requireTenant
          const profile = yield* requireProfile(tenantId, request.params["id"])
          yield* capture(store.revokeProfile(tenantId, profile.id))
          const cancelled = yield* capture(store.cancelApprovalsForProfile(profile.id))
          return { revoked: true as const, cancelledApprovals: cancelled }
        }))
      .handle("listApprovals", (request) =>
        Effect.gen(function*() {
          const tenantId = yield* requireTenant
          const status = request.query["status"]
          const [approvals, deliveries] = yield* capture(Effect.all([
            store.listApprovals(tenantId, status),
            store.listApprovalDeliveries(tenantId, status)
          ]))
          return {
            approvals: approvals.map((approval) => ({
              ...approval,
              deliveries: deliveries.filter((delivery) => delivery.approvalId === approval.id)
            }))
          }
        }))
      .handle("approve", (request) => Effect.gen(function*() {
        return yield* capture(approveApproval(
          { store, integrations, retentionDays: config.retentionDays },
          { tenantId: yield* requireTenant, id: request.params["id"], decidedBy: yield* decidedBy }
        )).pipe(
          Effect.catchTag("ApprovalNotFound", ({ id }) => new ApiNotFound({ error: `Unknown approval ${id}` })),
          Effect.catchTag("ApprovalConflict", ({ message }) => new ApiBadRequest({ error: message }))
        )
      }))
      .handle("decideApprovals", (request) => Effect.gen(function*() {
        return yield* capture(decideApprovals(
          { store, integrations, retentionDays: config.retentionDays },
          {
            tenantId: yield* requireTenant,
            ids: request.payload.ids,
            verdict: request.payload.verdict,
            decidedBy: yield* decidedBy,
            remember: request.payload.remember ?? false
          }
        )).pipe(Effect.catchTag("ApprovalConflict", ({ message }) => new ApiBadRequest({ error: message })))
      }))
      .handle("deny", (request) => Effect.gen(function*() {
        return yield* capture(denyApproval(
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
            ? (yield* capture(integrations.listIntegrations()))
              .map((entry) => entry.slug)
            : [slug]
          const reports: Array<DriftReport> = []
          for (const integration of slugs) {
            reports.push(yield* capture(refreshIntegrationSnapshot(
              { store: store, integrations },
              integration,
              tenantId
            )).pipe(Effect.catchTag("DriftRefreshError", (failure) =>
              new ApiBadRequest({
                error: `Could not re-read ${failure.integration}: ${String(failure.cause)}`
              }))))
          }
          return { reports }
        }))
      .handle("maintenance", () => Effect.gen(function*() {
        const report = yield* capture(runMaintenance(store, blobs))
        yield* capture(deliverDueApprovalNotifications({
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
            ...whenPresentMap("profileId", query["profileId"], ProfileId.make),
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
          return {
            records: yield* capture(store.listAudit(tenantId, { ...filter, limit, offset })),
            total: yield* capture(store.countAudit(tenantId, filter)),
            limit,
            offset
          }
        }))
  }))
