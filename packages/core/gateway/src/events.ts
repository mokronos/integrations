import { Context, Effect, Layer, PubSub, Stream } from "effect"
import type { Scope } from "effect"
import type { Integrations } from "@integragents/host"
import type { GatewayResource, TenantId } from "./domain.ts"
import { whenPresent } from "@integragents/contracts"
import type { GatewayStore, SettledApproval } from "./store/index.ts"

/** What changed, and when known, which of its records: approval ids for `approvals`. */
export interface GatewayResourceChange {
  readonly resource: GatewayResource
  readonly ids?: ReadonlyArray<string>
}

/** A change nobody can attribute to one tenant reaches every tenant. */
export interface GatewayChange extends GatewayResourceChange {
  readonly tenantId: TenantId | undefined
}

export interface EventBus {
  readonly publish: (change: GatewayChange) => Effect.Effect<void>
  /** Subscribes now: everything published after this returns reaches the stream. */
  readonly subscribe: (tenantId: TenantId) => Effect.Effect<Stream.Stream<GatewayResourceChange>, never, Scope.Scope>
}

export const makeGatewayEvents: Effect.Effect<EventBus> = Effect.map(PubSub.unbounded<GatewayChange>(), (pubsub) => ({
  publish: (change) => Effect.asVoid(PubSub.publish(pubsub, change)),
  subscribe: (tenantId) =>
    Effect.map(PubSub.subscribe(pubsub), (subscription) =>
      Stream.fromSubscription(subscription).pipe(
        Stream.filter((change) => change.tenantId === undefined || change.tenantId === tenantId),
        Stream.map((change): GatewayResourceChange => ({
          resource: change.resource,
          ...whenPresent("ids", change.ids)
        }))
      )
    )
}))

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
        : Effect.void
    )
  /** An approval write, announced with the approval it touched. */
  const touched = <A, E>(effect: Effect.Effect<A, E>, tenantId: TenantId, id: string): Effect.Effect<A, E> =>
    Effect.tap(effect, (result) =>
      changedSomething(result) ? events.publish({ tenantId, resource: "approvals", ids: [id] }) : Effect.void
    )
  /** Approvals a sweep decided, announced per tenant with their ids. */
  const settled = <E>(
    effect: Effect.Effect<ReadonlyArray<SettledApproval>, E>
  ): Effect.Effect<ReadonlyArray<SettledApproval>, E> =>
    Effect.tap(effect, (approvals) => {
      const byTenant = new Map<TenantId, Array<string>>()
      for (const { tenantId, approval } of approvals) {
        byTenant.set(tenantId, [...(byTenant.get(tenantId) ?? []), approval.id])
      }
      return Effect.forEach(byTenant, ([tenantId, ids]) => events.publish({ tenantId, resource: "approvals", ids }), {
        discard: true
      })
    })
  return {
    ...store,
    createProfile: (input) => after(store.createProfile(input), input.tenantId, "profiles"),
    updateProfileSettings: (tenantId, id, settings) =>
      after(store.updateProfileSettings(tenantId, id, settings), tenantId, "profiles"),
    renameProfile: (tenantId, id, name) => after(store.renameProfile(tenantId, id, name), tenantId, "profiles"),
    revokeProfile: (tenantId, id) => after(store.revokeProfile(tenantId, id), tenantId, "profiles", "approvals"),
    replaceProfileTools: (id, tools) => after(store.replaceProfileTools(id, tools), undefined, "profiles"),
    addApiKey: (input) => after(store.addApiKey(input), undefined, "profiles"),
    revokeApiKey: (id) => after(store.revokeApiKey(id), undefined, "profiles"),
    createApprovalDestination: (input) =>
      after(store.createApprovalDestination(input), input.tenantId, "approval-destinations"),
    deleteApprovalDestination: (tenantId, id) =>
      after(store.deleteApprovalDestination(tenantId, id), tenantId, "approval-destinations"),
    replaceProfileApprovalDestinations: (tenantId, profileId, ids) =>
      after(store.replaceProfileApprovalDestinations(tenantId, profileId, ids), tenantId, "profiles"),
    claimDueApprovalDeliveries: (now, limit) =>
      after(store.claimDueApprovalDeliveries(now, limit), undefined, "approvals"),
    settleApprovalDelivery: (input) => after(store.settleApprovalDelivery(input), undefined, "approvals"),
    createApprovalRule: (input) => after(store.createApprovalRule(input), undefined, "profiles"),
    updateApprovalRule: (id, pattern) => after(store.updateApprovalRule(id, pattern), undefined, "profiles"),
    deleteApprovalRule: (id) => after(store.deleteApprovalRule(id), undefined, "profiles"),
    createApproval: (input) =>
      Effect.tap(store.createApproval(input), (approval) =>
        events.publish({ tenantId: input.tenantId, resource: "approvals", ids: [approval.id] })
      ),
    collectApproval: (tenantId, id) => touched(store.collectApproval(tenantId, id), tenantId, id),
    claimApproval: (input) => touched(store.claimApproval(input), input.tenantId, input.id),
    settleApproval: (input) => touched(store.settleApproval(input), input.tenantId, input.id),
    cancelApprovalsForProfile: (profileId) => settled(store.cancelApprovalsForProfile(profileId)),
    expireApprovals: (now) => settled(store.expireApprovals(now)),
    settleInterruptedApprovals: (claimedBefore, error) =>
      settled(store.settleInterruptedApprovals(claimedBefore, error)),
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
