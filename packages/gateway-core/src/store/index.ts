import { mkdirSync } from "node:fs"
import path from "node:path"
import { LibsqlClient } from "@effect/sql-libsql"
import { Context, Effect, Layer, Option } from "effect"
import { Reactivity } from "effect/reactivity"
import { SqlClient } from "effect/sql"
import { isSealed } from "@integragents/integrations"
import { ApprovalDeliveryStoreService } from "./approval-deliveries.ts"
import type { ApprovalDeliveryStore } from "./approval-deliveries.ts"
import { ApprovalStoreService } from "./approvals.ts"
import type { ApprovalStore } from "./approvals.ts"
import { AuditStoreService } from "./audit.ts"
import type { AuditStore } from "./audit.ts"
import { IdentityStoreService } from "./identity.ts"
import type { IdentityStore } from "./identity.ts"
import { InvocationKeyStoreService } from "./invocation-keys.ts"
import type { InvocationKeyStore } from "./invocation-keys.ts"
import { OAuthStoreService } from "./oauth.ts"
import type { OAuthStore } from "./oauth.ts"
import { ProfileStoreService } from "./profiles.ts"
import type { ProfileStore } from "./profiles.ts"
import { operation, StoreSql } from "./sql.ts"
import type { GatewayStoreError, GatewayStoreOptions } from "./sql.ts"
import { ToolSnapshotStoreService } from "./tool-snapshots.ts"
import type { ToolSnapshotStore } from "./tool-snapshots.ts"

export { GatewayStoreError, GatewayStoreFailureKind } from "./sql.ts"
export type { GatewayStoreOptions } from "./sql.ts"
export type { ApprovalDecisionDeliveryJob, ApprovalDeliveryJob, ApprovalDeliveryStore } from "./approval-deliveries.ts"
export type { ApprovalStore, CreateApprovalInput, SettledApproval } from "./approvals.ts"
export type { AuditQuery, AuditStore, RecordAuditInput } from "./audit.ts"
export type {
  CreateSubjectInput,
  CreateTenantInput,
  IdentityOAuthStateRecord,
  IdentityStore,
  LoginRecord
} from "./identity.ts"
export { RememberedOutcome } from "./invocation-keys.ts"
export type { InvocationKeyRecord, InvocationKeyStore, KeyedCall } from "./invocation-keys.ts"
export type { OAuthStore } from "./oauth.ts"
export type { CreateProfileInput, GatewayOverviewCounts, ProfileSettings, ProfileStore } from "./profiles.ts"
export type { ToolSnapshotStore } from "./tool-snapshots.ts"

/** State a caller carries for the gateway and must hand back unread and unaltered. */
export interface SealedStateStore {
  sealState(text: string): Effect.Effect<string>
  /** What `sealState` sealed; nothing for any other text, including a tampered seal. */
  openState(token: string): Effect.Effect<Option.Option<string>>
}

/**
 * Everything the gateway keeps. Each member answers with an Effect: the store
 * runs on a SqlClient, so there is no promise boundary to lift over.
 */
export interface GatewayStore
  extends
    SealedStateStore,
    IdentityStore,
    ProfileStore,
    ApprovalStore,
    ApprovalDeliveryStore,
    OAuthStore,
    InvocationKeyStore,
    AuditStore,
    ToolSnapshotStore {
  close(): Effect.Effect<void, GatewayStoreError>
}

const areaLayers = Layer.mergeAll(
  IdentityStoreService.layer,
  ProfileStoreService.layer,
  ApprovalStoreService.layer,
  ApprovalDeliveryStoreService.layer,
  OAuthStoreService.layer,
  InvocationKeyStoreService.layer,
  AuditStoreService.layer,
  ToolSnapshotStoreService.layer
)

/**
 * The whole store as one service. Its parts stay private to this module, so
 * every write goes through the one value that decorators such as event
 * publishing wrap.
 */
export class GatewayStoreService extends Context.Service<GatewayStoreService, GatewayStore>()(
  "@integragents/gateway-core/GatewayStore"
) {
  static readonly layer = (
    options: GatewayStoreOptions
  ): Layer.Layer<GatewayStoreService, GatewayStoreError, SqlClient.SqlClient> =>
    Layer.effect(
      GatewayStoreService,
      Effect.gen(function* () {
        const { encryption } = yield* StoreSql
        return {
          sealState: (text) => Effect.sync(() => encryption.seal(text)),
          openState: (token) =>
            Effect.sync(() => (isSealed(token) ? Option.liftThrowable(encryption.open)(token) : Option.none())),
          ...(yield* IdentityStoreService),
          ...(yield* ProfileStoreService),
          ...(yield* ApprovalStoreService),
          ...(yield* ApprovalDeliveryStoreService),
          ...(yield* OAuthStoreService),
          ...(yield* InvocationKeyStoreService),
          ...(yield* AuditStoreService),
          ...(yield* ToolSnapshotStoreService),
          // The SqlClient owns the connection; closing it is the scope's business.
          close: () => operation("close", Effect.void)
        }
      })
    ).pipe(Layer.provide(areaLayers.pipe(Layer.provideMerge(StoreSql.layer(options)))))
}

/** The gateway's own SQLite file, opened with the pragmas it relies on. */
export const libsqlLayer = (databasePath: string): Layer.Layer<SqlClient.SqlClient> =>
  Layer.unwrap(
    Effect.sync(() => {
      mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 })
      return LibsqlClient.layer({ url: `file:${databasePath}` })
    })
  ).pipe(
    Layer.tap((context) => Effect.orDie(applyPragmas().pipe(Effect.provide(context)))),
    Layer.provide(Reactivity.layer)
  )

const applyPragmas = Effect.fn("GatewayStore.pragmas")(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql.unsafe("PRAGMA journal_mode = WAL")
  yield* sql.unsafe("PRAGMA foreign_keys = ON")
})

/** The gateway's store on whatever `SqlClient` is in context. */
export const createGatewayStore = (
  options: GatewayStoreOptions
): Effect.Effect<GatewayStore, GatewayStoreError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    return yield* GatewayStoreService
  }).pipe(Effect.provide(GatewayStoreService.layer(options)))
