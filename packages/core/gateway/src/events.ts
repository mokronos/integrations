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
    createConfiguredClient: (input) => after(store.createConfiguredClient(input), input.tenantId, "clients", "policies"),
    createClient: (input) => after(store.createClient(input), input.tenantId, "clients"),
    updateClientSettings: (input) => after(store.updateClientSettings(input), input.tenantId, "clients"),
    renameClient: (tenantId, id, name) => after(store.renameClient(tenantId, id, name), tenantId, "clients"),
    revokeClient: (tenantId, id) => after(store.revokeClient(tenantId, id), tenantId, "clients", "approvals"),
    addApiKey: (input) => after(store.addApiKey(input), undefined, "clients"),
    revokeApiKey: (id) => after(store.revokeApiKey(id), undefined, "clients"),
    createApprovalDestination: (input) => after(store.createApprovalDestination(input), input.tenantId, "approval-destinations"),
    deleteApprovalDestination: (tenantId, id) => after(store.deleteApprovalDestination(tenantId, id), tenantId, "approval-destinations"),
    replaceClientApprovalDestinations: (tenantId, clientId, ids) =>
      after(store.replaceClientApprovalDestinations(tenantId, clientId, ids), tenantId, "approval-destinations"),
    claimDueApprovalDeliveries: (now, limit) => after(store.claimDueApprovalDeliveries(now, limit), undefined, "approvals"),
    settleApprovalDelivery: (input) => after(store.settleApprovalDelivery(input), undefined, "approvals"),
    createAccessProfile: (input) => after(store.createAccessProfile(input), input.tenantId, "policies"),
    updateAccessProfile: (tenantId, id, name) => after(store.updateAccessProfile(tenantId, id, name), tenantId, "policies"),
    deleteAccessProfile: (tenantId, id) => after(store.deleteAccessProfile(tenantId, id), tenantId, "policies"),
    replaceAccessProfileTools: (id, tools) => after(store.replaceAccessProfileTools(id, tools), undefined, "policies"),
    assignAccessProfile: (tenantId, clientId, id) => after(store.assignAccessProfile(tenantId, clientId, id), tenantId, "clients"),
    createApprovalPolicy: (input) => after(store.createApprovalPolicy(input), input.tenantId, "policies"),
    updateApprovalPolicy: (tenantId, id, name) => after(store.updateApprovalPolicy(tenantId, id, name), tenantId, "policies"),
    deleteApprovalPolicy: (tenantId, id) => after(store.deleteApprovalPolicy(tenantId, id), tenantId, "policies"),
    replaceApprovalPolicyTools: (id, tools) => after(store.replaceApprovalPolicyTools(id, tools), undefined, "policies"),
    assignApprovalPolicy: (tenantId, clientId, id) => after(store.assignApprovalPolicy(tenantId, clientId, id), tenantId, "clients"),
    createApproval: (input) => after(store.createApproval(input), input.tenantId, "approvals"),
    collectApproval: (tenantId, id) => after(store.collectApproval(tenantId, id), tenantId, "approvals"),
    claimApproval: (input) => after(store.claimApproval(input), input.tenantId, "approvals"),
    settleApproval: (input) => after(store.settleApproval(input), input.tenantId, "approvals"),
    cancelApprovalsForClient: (clientId) => after(store.cancelApprovalsForClient(clientId), undefined, "approvals"),
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
