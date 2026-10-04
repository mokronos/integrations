import { Context, Effect, Layer, PubSub, Stream } from "effect"
import type { Scope } from "effect"
import type { Integrations } from "@integragents/host"
import type { GatewayResource, TenantId } from "./domain.ts"
import type { GatewayStore } from "./store-contract.ts"

/** A change nobody can attribute to one tenant reaches every tenant. */
export interface GatewayChange {
  readonly tenantId: TenantId | undefined
  readonly resource: GatewayResource
}

export interface EventBus {
  readonly publish: (change: GatewayChange) => Effect.Effect<void>
  /** Subscribes now: everything published after this returns reaches the stream. */
  readonly subscribe: (tenantId: TenantId) => Effect.Effect<Stream.Stream<GatewayResource>, never, Scope.Scope>
}

export const makeGatewayEvents: Effect.Effect<EventBus> = Effect.map(
  PubSub.unbounded<GatewayChange>(),
  (pubsub) => ({
    publish: (change) => Effect.asVoid(PubSub.publish(pubsub, change)),
    subscribe: (tenantId) =>
      Effect.map(PubSub.subscribe(pubsub), (subscription) =>
        Stream.fromSubscription(subscription).pipe(
          Stream.filter((change) => change.tenantId === undefined || change.tenantId === tenantId),
          Stream.map((change) => change.resource)
        ))
  })
)

export class GatewayEvents extends Context.Service<GatewayEvents, EventBus>()(
  "@integragents/gateway-core/GatewayEvents"
) {
  static readonly layer: Layer.Layer<GatewayEvents> = Layer.effect(GatewayEvents, makeGatewayEvents)
}

/** Sweeps and claims that touched no rows report `false`, `0`, or nothing. */
const changedSomething = <A>(result: A): boolean =>
  result !== false && result !== 0 && !(Array.isArray(result) && result.length === 0)

export const publishingStore = (store: GatewayStore, events: EventBus): GatewayStore => {
  const after = <A, E>(
    effect: Effect.Effect<A, E>,
    tenantId: TenantId | undefined,
    ...resources: ReadonlyArray<GatewayResource>
  ): Effect.Effect<A, E> =>
    Effect.tap(effect, (result) =>
      changedSomething(result)
        ? Effect.forEach(resources, (resource) => events.publish({ tenantId, resource }), { discard: true })
        : Effect.void)
  return {
    ...store,
    createProfile: (input) => after(store.createProfile(input), input.tenantId, "profiles"),
    updateProfileSettings: (tenantId, id, settings) => after(store.updateProfileSettings(tenantId, id, settings), tenantId, "profiles"),
    renameProfile: (tenantId, id, name) => after(store.renameProfile(tenantId, id, name), tenantId, "profiles"),
    revokeProfile: (tenantId, id) => after(store.revokeProfile(tenantId, id), tenantId, "profiles", "approvals"),
    replaceProfileTools: (id, tools) => after(store.replaceProfileTools(id, tools), undefined, "profiles"),
    addApiKey: (input) => after(store.addApiKey(input), undefined, "profiles"),
    revokeApiKey: (id) => after(store.revokeApiKey(id), undefined, "profiles"),
    createApprovalDestination: (input) => after(store.createApprovalDestination(input), input.tenantId, "approval-destinations"),
    deleteApprovalDestination: (tenantId, id) => after(store.deleteApprovalDestination(tenantId, id), tenantId, "approval-destinations"),
    replaceProfileApprovalDestinations: (tenantId, profileId, ids) =>
      after(store.replaceProfileApprovalDestinations(tenantId, profileId, ids), tenantId, "profiles"),
    claimDueApprovalDeliveries: (now, limit) => after(store.claimDueApprovalDeliveries(now, limit), undefined, "approvals"),
    settleApprovalDelivery: (input) => after(store.settleApprovalDelivery(input), undefined, "approvals"),
    createApprovalRule: (input) => after(store.createApprovalRule(input), undefined, "profiles"),
    updateApprovalRule: (id, pattern) => after(store.updateApprovalRule(id, pattern), undefined, "profiles"),
    deleteApprovalRule: (id) => after(store.deleteApprovalRule(id), undefined, "profiles"),
    createApproval: (input) => after(store.createApproval(input), input.tenantId, "approvals"),
    collectApproval: (tenantId, id) => after(store.collectApproval(tenantId, id), tenantId, "approvals"),
    claimApproval: (input) => after(store.claimApproval(input), input.tenantId, "approvals"),
    settleApproval: (input) => after(store.settleApproval(input), input.tenantId, "approvals"),
    cancelApprovalsForProfile: (profileId) => after(store.cancelApprovalsForProfile(profileId), undefined, "approvals"),
    expireApprovals: (now) => after(store.expireApprovals(now), undefined, "approvals"),
    recordAudit: (input) => after(store.recordAudit(input), input.tenantId, "audit"),
    expireAuditArguments: (now) => after(store.expireAuditArguments(now), undefined, "audit")
  }
}

export const publishingIntegrations = (
  integrations: Integrations["Service"],
  events: EventBus
): Integrations["Service"] => {
  const after = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> =>
    Effect.tap(effect, () => events.publish({ tenantId: undefined, resource: "integrations" }))
  return {
    ...integrations,
    addMcp: (options) => after(integrations.addMcp(options)),
    addOpenApi: (options) => after(integrations.addOpenApi(options)),
    renameIntegration: (slug, name) => after(integrations.renameIntegration(slug, name)),
    removeIntegration: (slug) => after(integrations.removeIntegration(slug)),
    createConnection: (options) => after(integrations.createConnection(options)),
    removeConnection: (reference) => after(integrations.removeConnection(reference)),
    refreshConnection: (reference) => after(integrations.refreshConnection(reference))
  }
}
