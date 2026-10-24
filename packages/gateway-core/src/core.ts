import { Context, Effect, Layer, Option } from "effect"
import type { Duration } from "effect"
import { HttpClient } from "effect/http"
import { SqlClient } from "effect/sql"
import { webCryptoLayer, whenPresent } from "@integragents/contracts"
import { BlobStore, integrationLayer, Integrations } from "@integragents/integrations"
import type { Egress, HostTools, IntegrationServices, StorageError } from "@integragents/integrations"
import { deliverDueApprovalNotifications } from "./approvals/webhooks.ts"
import { includeConnectionTools, pruneProfileTools } from "./profiles.ts"
import { ConnectionName, IntegrationSlug } from "./domain.ts"
import type { Encryption } from "./crypto.ts"
import { maintenanceLoop } from "./maintenance.ts"
import { createOAuthSessions, OAuthSessionError, sqlOAuthSessionStore } from "./connection-oauth/sessions.ts"
import type { OAuthSessions } from "./connection-oauth/sessions.ts"
import type { LocalAuthorizer, OAuthOperations } from "./connection-oauth/flows.ts"
import { GatewayEvents, publishingIntegrations, publishingStore } from "./events.ts"
import { notifyingDecisions } from "./approvals/decided.ts"
import { ApprovalReviewer } from "./approvals/reviewer.ts"
import type { InvokeDependencies } from "./invocation/invoke.ts"
import type { OnApprovalDecided } from "./approvals/decided.ts"
import { GatewayStoreError, GatewayStoreService } from "./store/index.ts"

export class OAuthFlowSessions extends Context.Service<OAuthFlowSessions, OAuthSessions>()(
  "@integragents/gateway-core/OAuthFlowSessions"
) {}

export type GatewayCoreServices = GatewayStoreService | IntegrationServices | OAuthFlowSessions | GatewayEvents

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
  /** Runs the tools of integrations the host registers with `registerHostIntegration`. */
  readonly hostTools?: HostTools["Service"]
  /** How long an approved call may run before maintenance settles it as interrupted; an hour when absent. */
  readonly executionLease?: Duration.Input
  /** Told of every decided call, however it was decided. See `OnApprovalDecided`. */
  readonly onApprovalDecided?: OnApprovalDecided
  /**
   * Judges new calls that ask before a human is notified; provided as the
   * `ApprovalReviewer` service, which the HTTP and MCP surfaces consult.
   */
  readonly reviewer?: ApprovalReviewer["Service"]
}

const oauthSessionsLayer = (
  options: Pick<GatewayCoreOptions, "publicUrlOf" | "authorizeLocally">
): Layer.Layer<OAuthFlowSessions, never, SqlClient.SqlClient | GatewayStoreService | GatewayEvents | OAuthOperations> =>
  Layer.effect(
    OAuthFlowSessions,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const store = yield* GatewayStoreService
      const events = yield* GatewayEvents
      const host = yield* Effect.context<OAuthOperations>()
      const sessionStore = sqlOAuthSessionStore(sql)
      return yield* Effect.acquireRelease(
        Effect.sync(() =>
          createOAuthSessions(host, {
            store: {
              ...sessionStore,
              put: (session) =>
                Effect.tap(sessionStore.put(session), () =>
                  events.publish({ tenantId: session.bindingTenant, resource: "integrations" })
                )
            },
            ...whenPresent("publicUrlOf", options.publicUrlOf),
            ...whenPresent("authorizeLocally", options.authorizeLocally),
            onConnected: (session) =>
              session.bindingTenant === undefined ||
              session.state.status !== "connected" ||
              session.request.newConnection !== true
                ? Effect.void
                : includeConnectionTools({
                    store,
                    integrations: Context.get(host, Integrations),
                    tenantId: session.bindingTenant,
                    integration: IntegrationSlug.make(session.integration),
                    connection: ConnectionName.make(session.connection)
                  }).pipe(
                    Effect.asVoid,
                    Effect.mapError((cause) => new OAuthSessionError({ operation: "bindConnectedTools", cause }))
                  )
          })
        ),
        (sessions) => sessions.stop()
      )
    })
  )

/**
 * Every write the store and the integration host commit is announced on the
 * gateway's event bus. Every decided call sends its `approval.decided`
 * notifications right away, rather than at the next maintenance sweep, and
 * reaches the host's hook.
 */
const publishing = (options: Pick<GatewayCoreOptions, "publicUrlOf" | "onApprovalDecided">) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const events = yield* GatewayEvents
      const raw = yield* Effect.context<GatewayStoreService | IntegrationServices | HttpClient.HttpClient>()
      const scope = yield* Effect.scope
      const published = publishingStore(Context.get(raw, GatewayStoreService), events)
      const deliver = Effect.suspend(() =>
        deliverDueApprovalNotifications({
          store: published,
          ...whenPresent("dashboardUrl", options.publicUrlOf?.())
        })
      ).pipe(
        Effect.provideService(HttpClient.HttpClient, Context.get(raw, HttpClient.HttpClient)),
        Effect.catchCause((cause) => Effect.logWarning("approval.decided delivery failed", cause))
      )
      const store = notifyingDecisions(published, (decided) =>
        Effect.andThen(Effect.forkIn(deliver, scope), options.onApprovalDecided?.(decided) ?? Effect.void)
      )
      return raw.pipe(
        Context.add(GatewayStoreService, store),
        Context.add(Integrations, publishingIntegrations(Context.get(raw, Integrations), events)),
        Context.add(GatewayEvents, events)
      )
    })
  )

const reconcileOnStart: Layer.Layer<never, GatewayStoreError | StorageError, GatewayStoreService | Integrations> =
  Layer.effectDiscard(
    Effect.gen(function* () {
      const store = yield* GatewayStoreService
      const integrations = yield* Integrations
      yield* integrations.recompileOpenApiTools()
      const tenants = yield* store.listTenants()
      yield* Effect.forEach(tenants, (tenant) => pruneProfileTools({ store, integrations, tenantId: tenant.id }), {
        discard: true
      })
    })
  )

const maintenanceLayer = (
  options: Pick<GatewayCoreOptions, "publicUrlOf" | "executionLease">
): Layer.Layer<never, never, GatewayStoreService | BlobStore | Integrations | HttpClient.HttpClient> =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const store = yield* GatewayStoreService
      const blobs = yield* BlobStore
      const integrations = yield* Integrations
      const publicUrlOf = options.publicUrlOf
      yield* Effect.forkScoped(
        maintenanceLoop(store, blobs, {
          ...whenPresent("executionLease", options.executionLease),
          afterSweep: Effect.suspend(() =>
            deliverDueApprovalNotifications({ store, ...whenPresent("dashboardUrl", publicUrlOf?.()) }).pipe(
              Effect.andThen(integrations.refreshDueConnections())
            )
          )
        }).pipe(Effect.provide(webCryptoLayer))
      )
    })
  )

/**
 * What `invokeAsProfile` needs, read from the services `gatewayCoreLayer`
 * provides, including the reviewer it was given. A host passes the rest of
 * `InvokeDependencies` here rather than assembling the whole by hand.
 */
export const coreInvokeDependencies = (
  options: Omit<InvokeDependencies, "store" | "integrations" | "oauth" | "reviewer"> = {}
): Effect.Effect<InvokeDependencies, never, GatewayStoreService | Integrations | OAuthFlowSessions> =>
  Effect.gen(function* () {
    const reviewer = yield* Effect.serviceOption(ApprovalReviewer)
    return {
      ...options,
      store: yield* GatewayStoreService,
      integrations: yield* Integrations,
      oauth: yield* OAuthFlowSessions,
      ...whenPresent("reviewer", Option.getOrUndefined(reviewer))
    }
  })

/**
 * Everything the gateway is, short of a transport: the store, the integration
 * host, and OAuth sessions on one `SqlClient`. A host that owns the process
 * provides this once and calls the core functions or mounts the API on top.
 */
export const gatewayCoreLayer = (
  options: GatewayCoreOptions
): Layer.Layer<
  GatewayCoreServices,
  GatewayStoreError | StorageError,
  SqlClient.SqlClient | HttpClient.HttpClient | Egress
> => {
  const base = publishing(options).pipe(
    Layer.provide(
      Layer.mergeAll(
        GatewayStoreService.layer({ encryption: options.encryption, ...whenPresent("migrate", options.migrate) }),
        integrationLayer({
          encryption: options.encryption,
          blobs: options.blobs,
          ...whenPresent("hostTools", options.hostTools)
        }),
        GatewayEvents.layer
      )
    )
  )
  return Layer.mergeAll(
    oauthSessionsLayer(options),
    reconcileOnStart,
    options.maintenance === false ? Layer.empty : maintenanceLayer(options),
    options.reviewer === undefined ? Layer.empty : Layer.succeed(ApprovalReviewer, options.reviewer)
  ).pipe(Layer.provideMerge(base))
}
