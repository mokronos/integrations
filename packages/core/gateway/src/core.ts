import { Context, Effect, Layer } from "effect"
import type { HttpClient } from "effect/unstable/http"
import { SqlClient } from "effect/unstable/sql"
import { whenPresent } from "@integragents/contracts"
import { integrationLayer, Integrations } from "@integragents/host"
import type { BlobStore, IntegrationServices, StorageError } from "@integragents/host"
import { deliverDueApprovalNotifications } from "./approval-delivery.ts"
import { reconcileConfigurations } from "./configurations.ts"
import type { Encryption } from "./crypto.ts"
import { maintenanceLoop } from "./maintenance.ts"
import { createOAuthSessions, OAuthSessionError, sqlOAuthSessionStore } from "./oauth-sessions.ts"
import type { OAuthSessions } from "./oauth-sessions.ts"
import type { LocalAuthorizer, OAuthOperations } from "./oauth.ts"
import { GatewayStoreError, GatewayStoreService } from "./store.ts"

export class OAuthFlowSessions extends Context.Service<OAuthFlowSessions, OAuthSessions>()(
  "@integragents/gateway-core/OAuthFlowSessions"
) {}

export type GatewayCoreServices = GatewayStoreService | IntegrationServices | OAuthFlowSessions

export interface GatewayCoreOptions {
  readonly encryption: Encryption
  /** Where uploaded blobs live; the only thing the core keeps outside the database. */
  readonly blobs: Layer.Layer<BlobStore, never, SqlClient.SqlClient>
  /** Where OAuth callbacks and approval links resolve to, read when needed. */
  readonly publicUrlOf?: () => string | undefined
  /** Completes OAuth on a host-owned loopback listener when there is no public URL. */
  readonly authorizeLocally?: LocalAuthorizer
  /** Bring the tables up to date on start. Off when the host runs the migrations itself. */
  readonly migrate?: boolean
  /** Sweep expired approvals and deliver notifications on a timer. Off when the host schedules it. */
  readonly maintenance?: boolean
}

const oauthSessionsLayer = (
  options: Pick<GatewayCoreOptions, "publicUrlOf" | "authorizeLocally">
): Layer.Layer<OAuthFlowSessions, never, SqlClient.SqlClient | GatewayStoreService | OAuthOperations> =>
  Layer.effect(
    OAuthFlowSessions,
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const store = yield* GatewayStoreService
      const host = yield* Effect.context<OAuthOperations>()
      return yield* Effect.acquireRelease(
        Effect.sync(() =>
          createOAuthSessions(host, {
            store: sqlOAuthSessionStore(sql),
            ...whenPresent("publicUrlOf", options.publicUrlOf),
            ...whenPresent("authorizeLocally", options.authorizeLocally),
            onConnected: (session) =>
              session.bindingTenant === undefined || session.state.status !== "connected"
                ? Effect.void
                : reconcileConfigurations({
                  store,
                  integrations: Context.get(host, Integrations),
                  tenantId: session.bindingTenant
                }).pipe(
                  Effect.asVoid,
                  Effect.mapError((cause) => new OAuthSessionError({ operation: "bindConnectedTools", cause }))
                )
          })),
        (sessions) => sessions.stop()
      )
    })
  )

const reconcileOnStart: Layer.Layer<never, GatewayStoreError | StorageError, GatewayStoreService | Integrations> =
  Layer.effectDiscard(Effect.gen(function*() {
    const store = yield* GatewayStoreService
    const integrations = yield* Integrations
    const tenants = yield* store.listTenants()
    yield* Effect.forEach(
      tenants,
      (tenant) => reconcileConfigurations({ store, integrations, tenantId: tenant.id }),
      { discard: true }
    )
  }))

const maintenanceLayer = (
  publicUrlOf: (() => string | undefined) | undefined
): Layer.Layer<never, never, GatewayStoreService | HttpClient.HttpClient> =>
  Layer.effectDiscard(Effect.gen(function*() {
    const store = yield* GatewayStoreService
    yield* Effect.forkScoped(maintenanceLoop(store, {
      afterSweep: Effect.suspend(() =>
        deliverDueApprovalNotifications({ store, ...whenPresent("dashboardUrl", publicUrlOf?.()) }))
    }))
  }))

/**
 * Everything the gateway is, short of a transport: the store, the integration
 * host, and OAuth sessions on one `SqlClient`. A host that owns the process
 * provides this once and calls the core functions or mounts the API on top.
 */
export const gatewayCoreLayer = (
  options: GatewayCoreOptions
): Layer.Layer<GatewayCoreServices, GatewayStoreError | StorageError, SqlClient.SqlClient | HttpClient.HttpClient> => {
  const base = Layer.mergeAll(
    GatewayStoreService.layer({ encryption: options.encryption, ...whenPresent("migrate", options.migrate) }),
    integrationLayer({ encryption: options.encryption, blobs: options.blobs })
  )
  return Layer.mergeAll(
    oauthSessionsLayer(options),
    reconcileOnStart,
    options.maintenance === false ? Layer.empty : maintenanceLayer(options.publicUrlOf)
  ).pipe(Layer.provideMerge(base))
}
