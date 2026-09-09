import { mkdirSync } from "node:fs"
import path from "node:path"
import type { InValue, Row } from "@libsql/client"
import { LibsqlClient } from "@effect/sql-libsql"
import { Context, Effect, Exit, Layer, Scope } from "effect"
import { Reactivity } from "effect/unstable/reactivity"
import { SqlClient, SqlError } from "effect/unstable/sql"
import type { Encryption } from "./crypto.ts"
import { webCrypto } from "@integrations/contracts"
import {
  AccessProfileId,
  Alias,
  canonicalArguments,
  connectionSubject,
  ApprovalDestinationId,
  ApprovalPolicyId,
  ClientId,
  defaultApprovalDelivery,
  defaultTenantId,
  SessionTokenHash,
  TenantId,
  ToolName
} from "./domain.ts"
import type {
  Client,
  PendingApproval
} from "./domain.ts"
import { applyGatewayMigrations } from "./migrate.ts"

import {
  millis, toAccessProfile, toAccessProfileTool, toApiKey, toApproval,
  toApprovalPolicy, toApprovalPolicyTool, toAuditRecord, toAuthSession, toClient,
  toApprovalDeliveryAttempt, toApprovalDestination, toExternalIdentity, toIdentityOAuthState, toLoginHandoff, toLoginRecord,
  toSnapshot, toSubject, toTenant
} from "./store-rows.ts"
export {
  GatewayStoreError,
  type AccessProfileToolInput, type ApprovalPolicyToolInput, type AuditQuery,
  type CreateAccessProfileInput, type CreateApprovalInput,
  type CreateApprovalPolicyInput, type CreateClientInput, type CreateSubjectInput,
  type CreateTenantInput, type GatewayOverviewCounts, type GatewayStore,
  type IdentityOAuthStateRecord, type LoginRecord, type RecordAuditInput
} from "./store-contract.ts"
import {
  GatewayStoreError,
  type GatewayStoreFailureKind,
  type AuditQuery,
  type GatewayStore,
} from "./store-contract.ts"

export class GatewayStoreService extends Context.Service<
  GatewayStoreService,
  GatewayStore
>()("@integrations/host/GatewayStore") {
  static readonly layer = (
    databasePath: string,
    encryption?: Encryption,
    options?: GatewayStoreOptions
  ): Layer.Layer<GatewayStoreService, GatewayStoreError> =>
    Layer.effect(
      GatewayStoreService,
      Effect.acquireRelease(
        createGatewayStore(databasePath, encryption, options),
        (store) =>
          store.close().pipe(Effect.catch((failure) =>
            Effect.logWarning(`The gateway store did not close cleanly: ${failure.message}`).pipe(
              Effect.annotateLogs({ operation: "GatewayStore.close" })
            )))
      )
    )
}

const now = (): number => Date.now()
const identity = (text: string): string => text

const bootstrapDefaultTenant = Effect.fn("GatewayStore.bootstrap")(function*(
  sql: SqlClient.SqlClient
) {
  const timestamp = now()
  yield* sql.unsafe(
    "INSERT INTO gateway_tenant (id, name, created_at) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING",
    [defaultTenantId, "Default", timestamp]
  )
  yield* sql.unsafe(
    `INSERT INTO gateway_access_profile (id, tenant_id, name, is_default, created_at, updated_at)
     VALUES (?, ?, 'Default', 1, ?, ?)
     ON CONFLICT (id) DO NOTHING`,
    [`default-access-profile:${defaultTenantId}`, defaultTenantId, timestamp, timestamp]
  )
  yield* sql.unsafe(
    `INSERT INTO gateway_approval_policy (id, tenant_id, name, is_default, created_at, updated_at)
     VALUES (?, ?, 'Default', 1, ?, ?)
     ON CONFLICT (id) DO NOTHING`,
    [`default-approval-policy:${defaultTenantId}`, defaultTenantId, timestamp, timestamp]
  )
})

interface SqlFilter {
  readonly where: string
  readonly args: ReadonlyArray<InValue>
}

const auditFilter = (
  options: Omit<AuditQuery, "limit" | "offset">
): SqlFilter => {
  const clauses: Array<string> = []
  const args: Array<InValue> = []
  if (options.clientId !== undefined) {
    clauses.push("client_id = ?")
    args.push(options.clientId)
  }
  if (options.alias !== undefined) {
    clauses.push("alias = ?")
    args.push(options.alias)
  }
  if (options.tool !== undefined) {
    clauses.push("tool = ?")
    args.push(options.tool)
  }
  if (options.outcome !== undefined) {
    clauses.push("outcome = ?")
    args.push(options.outcome)
  }
  if (options.since !== undefined) {
    clauses.push("created_at >= ?")
    args.push(options.since.getTime())
  }
  return {
    where: clauses.length === 0 ? "" : ` AND ${clauses.join(" AND ")}`,
    args
  }
}

const createGatewayStoreDriver = Effect.fn("GatewayStore.openDriver")(function*(
  databasePath: string,
  encryption?: Encryption
): Effect.fn.Return<GatewayStore, SqlError.SqlError, SqlClient.SqlClient> {
  const sql = yield* SqlClient.SqlClient
  yield* applyGatewayMigrations(sql)
  yield* bootstrapDefaultTenant(sql)

  const all = (
    query: string,
    args: ReadonlyArray<InValue> = []
  ): Effect.Effect<ReadonlyArray<Row>, SqlError.SqlError> =>
    sql.unsafe<Row>(query, [...args])

  const one = (
    query: string,
    args: ReadonlyArray<InValue> = []
  ): Effect.Effect<Row | undefined, SqlError.SqlError> =>
    Effect.map(all(query, args), (rows) => rows[0])

  const run = (
    query: string,
    args: ReadonlyArray<InValue> = []
  ): Effect.Effect<void, SqlError.SqlError> => Effect.asVoid(all(query, args))

  /**
   * How many rows a statement touched. Asking the driver would tie us to its
   * result shape, so the statement says `RETURNING` and we count what comes
   * back — which every SQLite dialect we run on answers the same way.
   */
  const changed = (
    query: string,
    args: ReadonlyArray<InValue> = []
  ): Effect.Effect<number, SqlError.SqlError> =>
    Effect.map(all(query, args), (rows) => rows.length)

  /** Runs statements as one unit, the way the driver's own batch did. */
  const batch = (
    statements: ReadonlyArray<{ readonly sql: string; readonly args: ReadonlyArray<InValue> }>
  ): Effect.Effect<void, SqlError.SqlError> =>
    sql.withTransaction(
      Effect.forEach(statements, (statement) => run(statement.sql, statement.args), {
        discard: true
      })
    )

  const requireClient = (id: ClientId): Effect.Effect<Client, SqlError.SqlError> =>
    Effect.gen(function*() {
      const row = yield* one("SELECT * FROM gateway_client WHERE id = ?", [id])
      if (row === undefined) return yield* Effect.die(new Error(`Unknown client ${id}`))
      return toClient(row)
    })

  const sealText = (text: string): string =>
    encryption === undefined ? text : encryption.seal(text)
  const openApproval = (row: Row): PendingApproval =>
    toApproval(row, encryption === undefined ? identity : encryption.open)

  const requireSession = (tokenHash: SessionTokenHash) =>
    Effect.gen(function*() {
      const row = yield* one(
      `SELECT gateway_session.*, gateway_login.email
         FROM gateway_session JOIN gateway_login ON gateway_login.subject_id = gateway_session.subject_id
        WHERE gateway_session.token_hash = ?`,
      [tokenHash]
    )
      if (row === undefined) return yield* Effect.die(new Error(`Failed to store session`))
      return toAuthSession(row)
    })

  const approvalMatch = (input: Parameters<GatewayStore["findUncollectedApproval"]>[0]) => {
    const canonical = canonicalArguments(input.arguments)
    return {
      sql: `tenant_id = ? AND client_id = ? AND alias = ?
        AND approval_policy_id = ? AND access_profile_id = ? AND tool = ?
        AND ((arguments_lookup IS NOT NULL AND arguments_lookup = ?)
          OR (arguments_lookup IS NULL AND arguments = ?)) AND collected_at IS NULL`,
      args: [input.tenantId, input.clientId, input.alias, input.approvalPolicyId, input.accessProfileId,
        input.tool, encryption === undefined ? canonical : encryption.lookup(canonical), canonical]
    }
  }

  const findUncollectedApproval = (input: Parameters<GatewayStore["findUncollectedApproval"]>[0]) =>
    Effect.gen(function*() {
      const match = approvalMatch(input)
      const row = yield* one(
        `SELECT * FROM gateway_pending_approval WHERE ${match.sql} ORDER BY created_at DESC LIMIT 1`,
        match.args
      )
      return row === undefined ? undefined : openApproval(row)
    })

  return {
    databasePath,

    createTenant: (input) => operation("createTenant", Effect.gen(function*() {
      const id = input?.id ?? TenantId.make(yield* Effect.orDie(webCrypto.randomUUIDv4))
      const name = input?.name ?? "Untitled"
      yield* sql.withTransaction(Effect.gen(function*() {
        yield* run(
          "INSERT INTO gateway_tenant (id, name, created_at) VALUES (?, ?, ?)",
          [id, name, now()]
        )
        const timestamp = now()
        yield* run(
         `INSERT INTO gateway_access_profile (id, tenant_id, name, is_default, created_at, updated_at)
           VALUES (?, ?, 'Default', 1, ?, ?)`,
          [AccessProfileId.make(`default-access-profile:${id}`), id, timestamp, timestamp]
        )
        yield* run(
          `INSERT INTO gateway_approval_policy (id, tenant_id, name, is_default, created_at, updated_at)
           VALUES (?, ?, 'Default', 1, ?, ?)`,
          [ApprovalPolicyId.make(`default-approval-policy:${id}`), id, timestamp, timestamp]
        )
      }))
      const row = yield* one("SELECT * FROM gateway_tenant WHERE id = ?", [id])
      if (row === undefined) return yield* Effect.die(new Error(`Failed to store tenant ${id}`))
      return toTenant(row)
    })),

    listTenants: () => operation("listTenants", Effect.gen(function*() {
      return (yield* all("SELECT * FROM gateway_tenant ORDER BY created_at", [])).map(toTenant)
    })),

    findTenantById: (id) => operation("findTenantById", Effect.gen(function*() {
      const row = yield* one("SELECT * FROM gateway_tenant WHERE id = ?", [id])
      return row === undefined ? undefined : toTenant(row)
    })),

    findTenantByName: (name) => operation("findTenantByName", Effect.gen(function*() {
      const row = yield* one("SELECT * FROM gateway_tenant WHERE name = ?", [name])
      return row === undefined ? undefined : toTenant(row)
    })),

    createSubject: (input) => operation("createSubject", Effect.gen(function*() {
      yield* run(
        "INSERT INTO gateway_subject (id, tenant_id, created_at) VALUES (?, ?, ?)",
        [input.id, input.tenantId, now()]
      )
      const row = yield* one("SELECT * FROM gateway_subject WHERE id = ?", [input.id])
      if (row === undefined) return yield* Effect.die(new Error(`Failed to store subject ${input.id}`))
      return toSubject(row)
    })),

    listSubjects: (tenantId) => operation("listSubjects", Effect.gen(function*() {
      return (yield* all(
        "SELECT * FROM gateway_subject WHERE tenant_id = ? ORDER BY created_at",
        [tenantId]
      )).map(toSubject)
    })),

    countSubjects: (tenantId) => operation("countSubjects", Effect.gen(function*() {
      const row = yield* one(
        "SELECT COUNT(*) AS total FROM gateway_subject WHERE tenant_id = ?",
        [tenantId]
      )
      return row === undefined ? 0 : Number(row["total"] ?? 0)
    })),

    findSubjectById: (id) => operation("findSubjectById", Effect.gen(function*() {
      const row = yield* one("SELECT * FROM gateway_subject WHERE id = ?", [id])
      return row === undefined ? undefined : toSubject(row)
    })),

    createLogin: (input) => operation("createLogin", Effect.gen(function*() {
      yield* run(
        "INSERT INTO gateway_login (subject_id, tenant_id, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)",
        [input.subjectId, input.tenantId, input.email, input.passwordHash, now()]
      )
      const row = yield* one("SELECT * FROM gateway_login WHERE subject_id = ?", [input.subjectId])
      if (row === undefined) return yield* Effect.die(new Error(`Failed to store login for ${input.email}`))
      return toLoginRecord(row)
    })),

    findLoginByEmail: (email) => operation("findLoginByEmail", Effect.gen(function*() {
      const row = yield* one("SELECT * FROM gateway_login WHERE email = ?", [email])
      return row === undefined ? undefined : toLoginRecord(row)
    })),

    findLoginBySubject: (subjectId) => operation("findLoginBySubject", Effect.gen(function*() {
      const row = yield* one("SELECT * FROM gateway_login WHERE subject_id = ?", [subjectId])
      return row === undefined ? undefined : toLoginRecord(row)
    })),

    countLogins: () => operation("countLogins", Effect.gen(function*() {
      const row = yield* one("SELECT COUNT(*) AS total FROM gateway_login", [])
      return row === undefined ? 0 : Number(row["total"] ?? 0)
    })),

    changeLoginEmail: (subjectId, email) => operation("changeLoginEmail", Effect.gen(function*() {
      yield* run("UPDATE gateway_login SET email = ? WHERE subject_id = ?", [email, subjectId])
    })),

    changeLoginPassword: (subjectId, passwordHash) => operation("changeLoginPassword", Effect.gen(function*() {
      yield* run("UPDATE gateway_login SET password_hash = ? WHERE subject_id = ?", [
        passwordHash,
        subjectId
      ])
    })),

    deleteSubject: (subjectId) => operation("deleteSubject", Effect.gen(function*() {
      yield* run("DELETE FROM gateway_subject WHERE id = ?", [subjectId])
    })),

    deleteTenant: (id) => operation("deleteTenant", Effect.gen(function*() {
      yield* run("DELETE FROM gateway_tenant WHERE id = ?", [id])
    })),

    revokeSubjectSessions: (subjectId, exceptTokenHash) => operation("revokeSubjectSessions", Effect.gen(function*() {
      return yield* exceptTokenHash === undefined
        ? changed("DELETE FROM gateway_session WHERE subject_id = ? RETURNING token_hash", [subjectId])
        : changed(
          "DELETE FROM gateway_session WHERE subject_id = ? AND token_hash != ? RETURNING token_hash",
          [subjectId, exceptTokenHash]
        )
    })),

    createSession: (input) => operation("createSession", Effect.gen(function*() {
      yield* run(
        "INSERT INTO gateway_session (token_hash, subject_id, tenant_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
        [input.tokenHash, input.subjectId, input.tenantId, now(), millis(input.expiresAt)]
      )
      return yield* requireSession(input.tokenHash)
    })),

    findLiveSession: (tokenHash) => operation("findLiveSession", Effect.gen(function*() {
      const row = yield* one(
        `SELECT gateway_session.*, gateway_login.email
           FROM gateway_session JOIN gateway_login ON gateway_login.subject_id = gateway_session.subject_id
          WHERE gateway_session.token_hash = ? AND gateway_session.expires_at > ?`,
        [tokenHash, now()]
      )
      return row === undefined ? undefined : toAuthSession(row)
    })),

    revokeSession: (tokenHash) => operation("revokeSession", Effect.gen(function*() {
      yield* run("DELETE FROM gateway_session WHERE token_hash = ?", [tokenHash])
    })),

    deleteExpiredSessions: (at) => operation("deleteExpiredSessions", Effect.gen(function*() {
      return yield* changed(
        "DELETE FROM gateway_session WHERE expires_at <= ? RETURNING token_hash",
        [millis(at)]
      )
    })),

    createExternalIdentity: (input) => operation("createExternalIdentity", Effect.gen(function*() {
      yield* run(
        `INSERT INTO gateway_external_identity
           (provider, provider_subject, subject_id, tenant_id, email, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (provider, provider_subject) DO UPDATE SET email = excluded.email`,
        [
          input.provider,
          input.providerSubject,
          input.subjectId,
          input.tenantId,
          input.email,
          now()
        ]
      )
      const row = yield* one(
        "SELECT * FROM gateway_external_identity WHERE provider = ? AND provider_subject = ?",
        [input.provider, input.providerSubject]
      )
      if (row === undefined) return yield* Effect.die(new Error(`Failed to store ${input.provider} identity`))
      return toExternalIdentity(row)
    })),

    findExternalIdentity: (provider, providerSubject) => operation("findExternalIdentity", Effect.gen(function*() {
      const row = yield* one(
        "SELECT * FROM gateway_external_identity WHERE provider = ? AND provider_subject = ?",
        [provider, providerSubject]
      )
      return row === undefined ? undefined : toExternalIdentity(row)
    })),

    listExternalIdentities: (subjectId) => operation("listExternalIdentities", Effect.gen(function*() {
      return (yield* all(
        "SELECT * FROM gateway_external_identity WHERE subject_id = ? ORDER BY created_at",
        [subjectId]
      )).map(toExternalIdentity)
    })),

    createLoginHandoff: (input) => operation("createLoginHandoff", Effect.gen(function*() {
      yield* run(
        `INSERT INTO gateway_login_handoff
           (request_hash, subject_id, tenant_id, email, created_at, expires_at, collected_at)
         VALUES (?, NULL, NULL, NULL, ?, ?, NULL)`,
        [input.requestHash, now(), millis(input.expiresAt)]
      )
      const row = yield* one(
        "SELECT * FROM gateway_login_handoff WHERE request_hash = ?",
        [input.requestHash]
      )
      if (row === undefined) return yield* Effect.die(new Error("Failed to store login handoff"))
      return toLoginHandoff(row)
    })),

    getLoginHandoff: (requestHash) => operation("getLoginHandoff", Effect.gen(function*() {
      const row = yield* one(
        "SELECT * FROM gateway_login_handoff WHERE request_hash = ?",
        [requestHash]
      )
      return row === undefined ? undefined : toLoginHandoff(row)
    })),

    completeLoginHandoff: (input) => operation("completeLoginHandoff", Effect.gen(function*() {
      return (yield* changed(
        `UPDATE gateway_login_handoff
            SET subject_id = ?, tenant_id = ?, email = ?
          WHERE request_hash = ? AND collected_at IS NULL AND expires_at > ?
          RETURNING request_hash`,
        [input.subjectId, input.tenantId, input.email, input.requestHash, now()]
      )) > 0
    })),

    collectLoginHandoff: (requestHash) => operation("collectLoginHandoff", Effect.gen(function*() {
      return (yield* changed(
        `UPDATE gateway_login_handoff SET collected_at = ?
          WHERE request_hash = ? AND subject_id IS NOT NULL
            AND collected_at IS NULL AND expires_at > ?
          RETURNING request_hash`,
        [now(), requestHash, now()]
      )) > 0
    })),

    createIdentityOAuthState: (input) => operation("createIdentityOAuthState", Effect.gen(function*() {
      yield* run(
        `INSERT INTO gateway_identity_oauth_state
           (state_hash, provider, handoff_hash, return_path, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
        [
          input.stateHash,
          input.provider,
          input.handoffHash,
          input.returnPath,
          millis(input.expiresAt)
        ]
      )
    })),

    consumeIdentityOAuthState: (stateHash) => operation("consumeIdentityOAuthState", Effect.gen(function*() {
      const row = yield* one(
        `DELETE FROM gateway_identity_oauth_state
          WHERE state_hash = ? AND expires_at > ?
          RETURNING *`,
        [stateHash, now()]
      )
      if (row === undefined) {
        yield* run("DELETE FROM gateway_identity_oauth_state WHERE state_hash = ?", [stateHash])
      }
      return row === undefined ? undefined : toIdentityOAuthState(row)
    })),

    deleteExpiredIdentityFlows: (at) => operation("deleteExpiredIdentityFlows", Effect.gen(function*() {
      const expiresAt = millis(at)
      const states = yield* changed(
        "DELETE FROM gateway_identity_oauth_state WHERE expires_at <= ? RETURNING state_hash",
        [expiresAt]
      )
      const handoffs = yield* changed(
        "DELETE FROM gateway_login_handoff WHERE expires_at <= ? RETURNING request_hash",
        [expiresAt]
      )
      return states + handoffs
    })),

    createConfiguredClient: (input) => operation("createConfiguredClient", Effect.gen(function*() {
      const at = now()
      yield* batch([
        {
          sql: `INSERT INTO gateway_access_profile (id, tenant_id, name, is_default, created_at, updated_at)
                VALUES (?, ?, ?, 0, ?, ?)`,
          args: [input.accessProfileId, input.tenantId, input.name, at, at]
        },
        {
          sql: `INSERT INTO gateway_approval_policy (id, tenant_id, name, is_default, created_at, updated_at)
                VALUES (?, ?, ?, 0, ?, ?)`,
          args: [input.approvalPolicyId, input.tenantId, input.name, at, at]
        },
        ...input.tools.flatMap((entry) => {
          const route = [entry.connection.owner, connectionSubject(entry.connection) ?? null, entry.connection.integration, entry.connection.name, entry.tool]
          return [
            { sql: `INSERT INTO gateway_access_profile_tool (access_profile_id, owner, subject, integration, connection_name, tool) VALUES (?, ?, ?, ?, ?, ?)`, args: [input.accessProfileId, ...route] },
            { sql: `INSERT INTO gateway_approval_policy_tool (approval_policy_id, owner, subject, integration, connection_name, tool, decision) VALUES (?, ?, ?, ?, ?, ?, ?)`, args: [input.approvalPolicyId, ...route, entry.decision] }
          ]
        }),
        {
          sql: `INSERT INTO gateway_client (id, tenant_id, access_profile_id, approval_policy_id, name, capabilities, approval_delivery, created_at, revoked_at)
                VALUES (?, ?, ?, ?, ?, '[]', ?, ?, NULL)`,
          args: [input.id, input.tenantId, input.accessProfileId, input.approvalPolicyId, input.name, JSON.stringify(defaultApprovalDelivery), at]
        }
      ])
      return yield* requireClient(input.id)
    })),

    createClient: (input) => operation("createClient", Effect.gen(function*() {
      yield* run(
        "INSERT INTO gateway_client (id, tenant_id, access_profile_id, approval_policy_id, name, capabilities, approval_delivery, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)",
        [
          input.id,
          input.tenantId,
          input.accessProfileId,
          input.approvalPolicyId,
          input.name,
          JSON.stringify(input.capabilities),
          JSON.stringify(input.approvalDelivery ?? defaultApprovalDelivery),
          now()
        ]
      )
      return yield* requireClient(input.id)
    })),

    listClients: (tenantId) => operation("listClients", Effect.gen(function*() {
      return (yield* all(
        "SELECT * FROM gateway_client WHERE tenant_id = ? ORDER BY created_at",
        [tenantId]
      )).map(toClient)
    })),

    overviewCounts: (tenantId) => operation("overviewCounts", Effect.gen(function*() {
      const row = yield* one(
        `SELECT
          (SELECT COUNT(*) FROM gateway_client
            WHERE tenant_id = ? AND revoked_at IS NULL) AS clients,
          (SELECT COUNT(*) FROM gateway_access_profile WHERE tenant_id = ?) AS access_profiles,
          (SELECT COUNT(*) FROM gateway_access_profile_tool AS tool
            JOIN gateway_access_profile AS profile ON profile.id = tool.access_profile_id
            WHERE profile.tenant_id = ?) AS access_profile_tools,
          (SELECT COUNT(*) FROM gateway_approval_policy WHERE tenant_id = ?) AS approval_policies,
          (SELECT COUNT(*) FROM gateway_approval_policy_tool AS tool
            JOIN gateway_approval_policy AS policy ON policy.id = tool.approval_policy_id
            WHERE policy.tenant_id = ?) AS approval_policy_tools,
          (SELECT COUNT(*) FROM gateway_api_key AS api_key
            JOIN gateway_client AS client ON client.id = api_key.client_id
            WHERE client.tenant_id = ? AND client.revoked_at IS NULL
              AND api_key.revoked_at IS NULL) AS keys,
          (SELECT COUNT(*) FROM gateway_pending_approval
            WHERE tenant_id = ? AND status = 'pending' AND expires_at > ?) AS pending_approvals`,
        [tenantId, tenantId, tenantId, tenantId, tenantId, tenantId, tenantId, now()]
      )
      return {
        clients: Number(row?.["clients"] ?? 0),
        accessProfiles: Number(row?.["access_profiles"] ?? 0),
        accessProfileTools: Number(row?.["access_profile_tools"] ?? 0),
        approvalPolicies: Number(row?.["approval_policies"] ?? 0),
        approvalPolicyTools: Number(row?.["approval_policy_tools"] ?? 0),
        keys: Number(row?.["keys"] ?? 0),
        pendingApprovals: Number(row?.["pending_approvals"] ?? 0)
      }
    })),

    findClientById: (tenantId, id) => operation("findClientById", Effect.gen(function*() {
      const row = yield* one(
        "SELECT * FROM gateway_client WHERE tenant_id = ? AND id = ?",
        [tenantId, id]
      )
      return row === undefined ? undefined : toClient(row)
    })),

    findClientByName: (tenantId, name) => operation("findClientByName", Effect.gen(function*() {
      const row = yield* one(
        "SELECT * FROM gateway_client WHERE tenant_id = ? AND name = ?",
        [tenantId, name]
      )
      return row === undefined ? undefined : toClient(row)
    })),

    updateClientSettings: (input) => operation("updateClientSettings", Effect.gen(function*() {
      yield* run(
        `UPDATE gateway_client SET capabilities = ?, approval_delivery = ?
          WHERE tenant_id = ? AND id = ? AND revoked_at IS NULL`,
        [
          JSON.stringify(input.capabilities),
          JSON.stringify(input.approvalDelivery),
          input.tenantId,
          input.id
        ]
      )
      return yield* requireClient(input.id)
    })),

    revokeClient: (tenantId, id) => operation("revokeClient", Effect.gen(function*() {
      yield* run(
        "UPDATE gateway_client SET revoked_at = ? WHERE tenant_id = ? AND id = ? AND revoked_at IS NULL",
        [now(), tenantId, id]
      )
    })),

    createApprovalDestination: (input) => operation("createApprovalDestination", Effect.gen(function*() {
      yield* run(
        `INSERT INTO gateway_approval_destination
          (id, tenant_id, name, type, url, signing_secret, created_at, deleted_at)
         VALUES (?, ?, ?, 'webhook', ?, ?, ?, NULL)`,
        [input.id, input.tenantId, input.name, input.url, sealText(input.signingSecret), now()]
      )
      const row = yield* one("SELECT * FROM gateway_approval_destination WHERE id = ?", [input.id])
      if (row === undefined) return yield* Effect.die(new Error(`Failed to store approval destination ${input.id}`))
      return toApprovalDestination(row)
    })),

    listApprovalDestinations: (tenantId) => operation("listApprovalDestinations", Effect.gen(function*() {
      return (yield* all("SELECT * FROM gateway_approval_destination WHERE tenant_id = ? AND deleted_at IS NULL ORDER BY name", [tenantId]))
        .map(toApprovalDestination)
    })),

    deleteApprovalDestination: (tenantId, id) => operation("deleteApprovalDestination", Effect.gen(function*() {
      yield* run("UPDATE gateway_approval_destination SET deleted_at = ? WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL", [now(), tenantId, id])
    })),

    listClientApprovalDestinationIds: (clientId) => operation("listClientApprovalDestinationIds", Effect.gen(function*() {
      return (yield* all("SELECT destination_id FROM gateway_client_approval_destination WHERE client_id = ? ORDER BY destination_id", [clientId]))
        .map((row) => ApprovalDestinationId.make(String(row["destination_id"])))
    })),

    replaceClientApprovalDestinations: (tenantId, clientId, ids) => operation("replaceClientApprovalDestinations", Effect.gen(function*() {
      const statements = [
        { sql: "DELETE FROM gateway_client_approval_destination WHERE client_id = ?", args: [clientId] },
        ...ids.map((id) => ({
          sql: `INSERT INTO gateway_client_approval_destination (client_id, destination_id)
                SELECT ?, id FROM gateway_approval_destination WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL`,
          args: [clientId, tenantId, id]
        }))
      ]
      yield* batch(statements)
      return (yield* all(
        `SELECT destination_id FROM gateway_client_approval_destination
          WHERE client_id = ? ORDER BY destination_id`,
        [clientId]
      )).map((row) => ApprovalDestinationId.make(String(row["destination_id"])))
    })),

    listApprovalDeliveries: (tenantId, approvalId) => operation("listApprovalDeliveries", Effect.gen(function*() {
      return (yield* all(
        `SELECT delivery.*, destination.name AS destination_name
           FROM gateway_approval_delivery AS delivery
           JOIN gateway_approval_destination AS destination ON destination.id = delivery.destination_id
           JOIN gateway_pending_approval AS approval ON approval.id = delivery.approval_id
          WHERE approval.tenant_id = ? AND approval.id = ? ORDER BY destination.name`,
        [tenantId, approvalId]
      )).map(toApprovalDeliveryAttempt)
    })),

    claimDueApprovalDeliveries: (at, limit) => operation("claimDueApprovalDeliveries", Effect.gen(function*() {
      const claimed = yield* all(
        `UPDATE gateway_approval_delivery
                 SET next_attempt_at = ?
               WHERE id IN (
                 SELECT delivery.id FROM gateway_approval_delivery AS delivery
                 JOIN gateway_pending_approval AS approval ON approval.id = delivery.approval_id
                 WHERE delivery.status IN ('pending', 'retrying') AND delivery.next_attempt_at <= ?
                   AND approval.status = 'pending' AND approval.expires_at > ?
                 ORDER BY delivery.next_attempt_at LIMIT ?
               ) AND next_attempt_at <= ?
               RETURNING id`,
        [millis(new Date(at.getTime() + 60_000)), millis(at), millis(at), limit, millis(at)]
      )
      const ids = claimed.map((row) => String(row["id"]))
      if (ids.length === 0) return []
      const placeholders = ids.map(() => "?").join(", ")
      const rows = yield* all(
        `SELECT delivery.*, destination.name AS destination_name, destination.url,
                destination.signing_secret, approval.tenant_id, approval.client_id,
                client.name AS client_name, approval.alias, approval.tool, approval.expires_at
           FROM gateway_approval_delivery AS delivery
           JOIN gateway_approval_destination AS destination ON destination.id = delivery.destination_id
           JOIN gateway_pending_approval AS approval ON approval.id = delivery.approval_id
           JOIN gateway_client AS client ON client.id = approval.client_id
          WHERE delivery.id IN (${placeholders})`,
        ids
      )
      return rows.map((row) => ({
        ...toApprovalDeliveryAttempt(row),
        tenantId: TenantId.make(String(row["tenant_id"])),
        clientId: ClientId.make(String(row["client_id"])),
        clientName: String(row["client_name"]),
        alias: Alias.make(String(row["alias"])),
        tool: ToolName.make(String(row["tool"])),
        expiresAt: new Date(Number(row["expires_at"])),
        url: String(row["url"]),
        signingSecret: encryption === undefined ? String(row["signing_secret"]) : encryption.open(String(row["signing_secret"]))
      }))
    })),

    settleApprovalDelivery: (input) => operation("settleApprovalDelivery", Effect.gen(function*() {
      yield* run(
        `UPDATE gateway_approval_delivery
            SET status = ?, attempts = attempts + 1, next_attempt_at = ?,
                delivered_at = CASE WHEN ? = 'delivered' THEN ? ELSE delivered_at END,
                last_error = ?
          WHERE id = ?`,
        [input.status, input.nextAttemptAt === null ? null : millis(input.nextAttemptAt), input.status, now(), input.error, input.id]
      )
    })),

    addApiKey: (input) => operation("addApiKey", Effect.gen(function*() {
      yield* run(
        "INSERT INTO gateway_api_key (id, client_id, hash, created_at, last_used_at, revoked_at) VALUES (?, ?, ?, ?, NULL, NULL)",
        [input.id, input.clientId, input.hash, now()]
      )
      const row = yield* one("SELECT * FROM gateway_api_key WHERE id = ?", [input.id])
      if (row === undefined) return yield* Effect.die(new Error(`Failed to store API key ${input.id}`))
      return toApiKey(row)
    })),

    listApiKeys: (clientId) => operation("listApiKeys", Effect.gen(function*() {
      return (yield* all("SELECT * FROM gateway_api_key WHERE client_id = ? ORDER BY created_at", [clientId]))
        .map(toApiKey)
    })),

    findApiKeyByHash: (hash) => operation("findApiKeyByHash", Effect.gen(function*() {
      const row = yield* one(
        `SELECT gateway_api_key.*, gateway_client.tenant_id AS client_tenant_id,
                 gateway_client.access_profile_id AS client_access_profile_id,
                 gateway_client.approval_policy_id AS client_approval_policy_id,
                gateway_client.name AS client_name,
                gateway_client.capabilities AS client_capabilities,
                gateway_client.approval_delivery AS client_approval_delivery,
                gateway_client.created_at AS client_created_at, gateway_client.revoked_at AS client_revoked_at
           FROM gateway_api_key JOIN gateway_client ON gateway_client.id = gateway_api_key.client_id
          WHERE gateway_api_key.hash = ?`,
        [hash]
      )
      if (row === undefined) return undefined
      return {
        key: toApiKey(row),
        client: toClient({
          ...row,
          id: row["client_id"] ?? "",
          tenant_id: row["client_tenant_id"] ?? "",
           access_profile_id: row["client_access_profile_id"] ?? "",
           approval_policy_id: row["client_approval_policy_id"] ?? "",
          name: row["client_name"] ?? "",
          capabilities: row["client_capabilities"] ?? "[]",
          approval_delivery: row["client_approval_delivery"] ?? JSON.stringify(defaultApprovalDelivery),
          created_at: row["client_created_at"] ?? 0,
          revoked_at: row["client_revoked_at"] ?? null
        })
      }
    })),

    touchApiKey: (id) => operation("touchApiKey", Effect.gen(function*() {
      yield* run("UPDATE gateway_api_key SET last_used_at = ? WHERE id = ?", [now(), id])
    })),

    revokeApiKey: (id) => operation("revokeApiKey", Effect.gen(function*() {
      yield* run("UPDATE gateway_api_key SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", [now(), id])
    })),

    createAccessProfile: (input) => operation("createAccessProfile", Effect.gen(function*() {
      const timestamp = now()
      yield* run(
        `INSERT INTO gateway_access_profile (id, tenant_id, name, is_default, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          input.id, input.tenantId, input.name, input.isDefault === true ? 1 : 0, timestamp, timestamp
        ]
      )
      const row = yield* one("SELECT * FROM gateway_access_profile WHERE id = ?", [input.id])
      if (row === undefined) return yield* Effect.die(new Error(`Failed to store access profile ${input.id}`))
      return toAccessProfile(row)
    })),

    updateAccessProfile: (tenantId, id, name) => operation("updateAccessProfile", Effect.gen(function*() {
      yield* run(
        "UPDATE gateway_access_profile SET name = ?, updated_at = ? WHERE tenant_id = ? AND id = ?",
        [name, now(), tenantId, id]
      )
      const row = yield* one("SELECT * FROM gateway_access_profile WHERE tenant_id = ? AND id = ?", [tenantId, id])
      if (row === undefined) return yield* Effect.die(new Error(`Unknown access profile ${id}`))
      return toAccessProfile(row)
    })),

    deleteAccessProfile: (tenantId, id) => operation("deleteAccessProfile", Effect.gen(function*() {
      const removed = yield* changed(
        `DELETE FROM gateway_access_profile
          WHERE tenant_id = ? AND id = ? AND is_default = 0
            AND NOT EXISTS (SELECT 1 FROM gateway_client WHERE access_profile_id = ?)
          RETURNING id`,
        [tenantId, id, id]
      )
      if (removed === 0) {
        return yield* Effect.die(new Error(`Access profile ${id} is default, assigned, or does not exist`))
      }
    })),

    listAccessProfiles: (tenantId) => operation("listAccessProfiles", Effect.gen(function*() {
      return (yield* all("SELECT * FROM gateway_access_profile WHERE tenant_id = ? ORDER BY is_default DESC, name", [tenantId])).map(toAccessProfile)
    })),

    findAccessProfile: (tenantId, id) => operation("findAccessProfile", Effect.gen(function*() {
      const row = yield* one("SELECT * FROM gateway_access_profile WHERE tenant_id = ? AND id = ?", [tenantId, id])
      return row === undefined ? undefined : toAccessProfile(row)
    })),

    findDefaultAccessProfile: (tenantId) => operation("findDefaultAccessProfile", Effect.gen(function*() {
      const row = yield* one("SELECT * FROM gateway_access_profile WHERE tenant_id = ? AND is_default = 1", [tenantId])
      return row === undefined ? undefined : toAccessProfile(row)
    })),

    findAccessProfileForClient: (clientId) => operation("findAccessProfileForClient", Effect.gen(function*() {
      const row = yield* one(
        `SELECT profile.* FROM gateway_access_profile AS profile
           JOIN gateway_client AS client ON client.access_profile_id = profile.id
           WHERE client.id = ?`,
        [clientId]
      )
      return row === undefined ? undefined : toAccessProfile(row)
    })),

    listAccessProfileTools: (id) => operation("listAccessProfileTools", Effect.gen(function*() {
      return (yield* all("SELECT * FROM gateway_access_profile_tool WHERE access_profile_id = ? ORDER BY integration, connection_name, tool", [id])).map(toAccessProfileTool)
    })),

    replaceAccessProfileTools: (id, tools) => operation("replaceAccessProfileTools", Effect.gen(function*() {
      yield* sql.withTransaction(Effect.gen(function*() {
        yield* run("DELETE FROM gateway_access_profile_tool WHERE access_profile_id = ?", [id])
        for (const tool of tools) {
          yield* run(
            `INSERT INTO gateway_access_profile_tool
               (access_profile_id, owner, subject, integration, connection_name, tool)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
              id,
              tool.connection.owner,
              tool.connection.owner === "user" ? tool.connection.subject : null,
              tool.connection.integration,
              tool.connection.name,
              tool.tool
            ]
          )
        }
        yield* run(
          `UPDATE gateway_access_profile
              SET updated_at = CASE WHEN updated_at >= ? THEN updated_at + 1 ELSE ? END
            WHERE id = ?`,
          [now(), now(), id]
        )
      }))
      return (yield* all("SELECT * FROM gateway_access_profile_tool WHERE access_profile_id = ? ORDER BY integration, connection_name, tool", [id])).map(toAccessProfileTool)
    })),

    assignAccessProfile: (tenantId, clientId, id) => operation("assignAccessProfile", Effect.gen(function*() {
      const assigned = yield* changed(
        `UPDATE gateway_client SET access_profile_id = ?
          WHERE tenant_id = ? AND id = ? AND EXISTS (
            SELECT 1 FROM gateway_access_profile WHERE id = ? AND tenant_id = ?
          )
          RETURNING id`,
        [id, tenantId, clientId, id, tenantId]
      )
      if (assigned === 0) {
        return yield* Effect.die(
          new Error(`Access profile ${id} cannot be assigned to client ${clientId}`)
        )
      }
      return yield* requireClient(clientId)
    })),

    createApprovalPolicy: (input) => operation("createApprovalPolicy", Effect.gen(function*() {
      const timestamp = now()
      yield* run(
        `INSERT INTO gateway_approval_policy (id, tenant_id, name, is_default, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [input.id, input.tenantId, input.name, input.isDefault === true ? 1 : 0, timestamp, timestamp]
      )
      const row = yield* one("SELECT * FROM gateway_approval_policy WHERE id = ?", [input.id])
      if (row === undefined) return yield* Effect.die(new Error(`Failed to store approval policy ${input.id}`))
      return toApprovalPolicy(row)
    })),

    updateApprovalPolicy: (tenantId, id, name) => operation("updateApprovalPolicy", Effect.gen(function*() {
      yield* run("UPDATE gateway_approval_policy SET name = ?, updated_at = ? WHERE tenant_id = ? AND id = ?", [name, now(), tenantId, id])
      const row = yield* one("SELECT * FROM gateway_approval_policy WHERE tenant_id = ? AND id = ?", [tenantId, id])
      if (row === undefined) return yield* Effect.die(new Error(`Unknown approval policy ${id}`))
      return toApprovalPolicy(row)
    })),

    deleteApprovalPolicy: (tenantId, id) => operation("deleteApprovalPolicy", Effect.gen(function*() {
      const removed = yield* changed(
        `DELETE FROM gateway_approval_policy WHERE tenant_id = ? AND id = ? AND is_default = 0
          AND NOT EXISTS (SELECT 1 FROM gateway_client WHERE approval_policy_id = ?)
          RETURNING id`,
        [tenantId, id, id]
      )
      if (removed === 0) {
        return yield* Effect.die(
          new Error(`Approval policy ${id} is default, assigned, or does not exist`)
        )
      }
    })),

    listApprovalPolicies: (tenantId) => operation("listApprovalPolicies", Effect.gen(function*() {
      return (yield* all("SELECT * FROM gateway_approval_policy WHERE tenant_id = ? ORDER BY is_default DESC, name", [tenantId])).map(toApprovalPolicy)
    })),

    findApprovalPolicy: (tenantId, id) => operation("findApprovalPolicy", Effect.gen(function*() {
      const row = yield* one("SELECT * FROM gateway_approval_policy WHERE tenant_id = ? AND id = ?", [tenantId, id])
      return row === undefined ? undefined : toApprovalPolicy(row)
    })),

    findDefaultApprovalPolicy: (tenantId) => operation("findDefaultApprovalPolicy", Effect.gen(function*() {
      const row = yield* one("SELECT * FROM gateway_approval_policy WHERE tenant_id = ? AND is_default = 1", [tenantId])
      return row === undefined ? undefined : toApprovalPolicy(row)
    })),

    findApprovalPolicyForClient: (clientId) => operation("findApprovalPolicyForClient", Effect.gen(function*() {
      const row = yield* one(`SELECT policy.* FROM gateway_approval_policy AS policy
        JOIN gateway_client AS client ON client.approval_policy_id = policy.id WHERE client.id = ?`, [clientId])
      return row === undefined ? undefined : toApprovalPolicy(row)
    })),

    listApprovalPolicyTools: (id) => operation("listApprovalPolicyTools", Effect.gen(function*() {
      return (yield* all("SELECT * FROM gateway_approval_policy_tool WHERE approval_policy_id = ? ORDER BY integration, connection_name, tool", [id])).map(toApprovalPolicyTool)
    })),

    replaceApprovalPolicyTools: (id, tools) => operation("replaceApprovalPolicyTools", Effect.gen(function*() {
      yield* sql.withTransaction(Effect.gen(function*() {
        yield* run("DELETE FROM gateway_approval_policy_tool WHERE approval_policy_id = ?", [id])
        for (const tool of tools) {
          yield* run(`INSERT INTO gateway_approval_policy_tool
            (approval_policy_id, owner, subject, integration, connection_name, tool, decision)
            VALUES (?, ?, ?, ?, ?, ?, ?)`, [
            id, tool.connection.owner, tool.connection.owner === "user" ? tool.connection.subject : null,
            tool.connection.integration, tool.connection.name, tool.tool, tool.decision
          ])
        }
        yield* run(`UPDATE gateway_approval_policy SET updated_at = CASE WHEN updated_at >= ? THEN updated_at + 1 ELSE ? END WHERE id = ?`, [now(), now(), id])
      }))
      return (yield* all("SELECT * FROM gateway_approval_policy_tool WHERE approval_policy_id = ? ORDER BY integration, connection_name, tool", [id])).map(toApprovalPolicyTool)
    })),

    assignApprovalPolicy: (tenantId, clientId, id) => operation("assignApprovalPolicy", Effect.gen(function*() {
      const assigned = yield* changed(
        `UPDATE gateway_client SET approval_policy_id = ? WHERE tenant_id = ? AND id = ? AND EXISTS (
          SELECT 1 FROM gateway_approval_policy WHERE id = ? AND tenant_id = ?)
          RETURNING id`,
        [id, tenantId, clientId, id, tenantId]
      )
      if (assigned === 0) {
        return yield* Effect.die(
          new Error(`Approval policy ${id} cannot be assigned to client ${clientId}`)
        )
      }
      return yield* requireClient(clientId)
    })),

    createApproval: (input) => operation("createApproval", Effect.gen(function*() {
      const match = approvalMatch(input)
      const canonical = canonicalArguments(input.arguments)
      const createdAt = now()
      yield* batch([
        { sql: `INSERT INTO gateway_pending_approval
           (id, tenant_id, client_id, approval_policy_id, access_profile_id, alias, tool, arguments, arguments_lookup, status, created_at, expires_at, decided_at, decided_by, result, error, collected_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL, NULL, NULL, NULL, NULL
          WHERE NOT EXISTS (SELECT 1 FROM gateway_pending_approval WHERE ${match.sql})`, args: [
          input.id,
          input.tenantId,
          input.clientId,
          input.approvalPolicyId,
          input.accessProfileId,
          input.alias,
          input.tool,
          sealText(canonical),
          encryption === undefined ? null : encryption.lookup(canonical),
          createdAt,
          millis(input.expiresAt),
          ...match.args
        ] },
        { sql: `INSERT INTO gateway_approval_delivery
             (id, approval_id, destination_id, status, attempts, next_attempt_at, delivered_at, last_error)
           SELECT lower(hex(randomblob(16))), ?, assignment.destination_id, 'pending', 0, ?, NULL, NULL
             FROM gateway_client_approval_destination AS assignment
             JOIN gateway_approval_destination AS destination ON destination.id = assignment.destination_id
            WHERE assignment.client_id = ? AND destination.deleted_at IS NULL
              AND EXISTS (SELECT 1 FROM gateway_pending_approval WHERE id = ?)`, args: [input.id, createdAt, input.clientId, input.id] }
      ])
      const approval = yield* findUncollectedApproval(input)
      if (approval === undefined) return yield* Effect.die(new Error(`Failed to store approval ${input.id}`))
      return approval
    })),

    findUncollectedApproval: (input) =>
      operation("findUncollectedApproval", findUncollectedApproval(input)),

    collectApproval: (tenantId, id) => operation("collectApproval", Effect.gen(function*() {
      return (yield* changed(
        `UPDATE gateway_pending_approval
            SET collected_at = ?
          WHERE tenant_id = ? AND id = ? AND collected_at IS NULL
            AND status IN ('approved', 'denied', 'expired')
          RETURNING id`,
        [now(), tenantId, id]
      )) > 0
    })),

    getApproval: (tenantId, id) => operation("getApproval", Effect.gen(function*() {
      const row = yield* one(
        "SELECT * FROM gateway_pending_approval WHERE tenant_id = ? AND id = ?",
        [tenantId, id]
      )
      return row === undefined ? undefined : openApproval(row)
    })),

    listApprovals: (tenantId, status) => operation("listApprovals", Effect.gen(function*() {
      return (status === undefined
        ? yield* all(
          "SELECT * FROM gateway_pending_approval WHERE tenant_id = ? ORDER BY created_at DESC",
          [tenantId]
        )
        : yield* all(
          "SELECT * FROM gateway_pending_approval WHERE tenant_id = ? AND status = ? ORDER BY created_at DESC",
          [tenantId, status]
        )).map(openApproval)
    })),

    claimApproval: (input) => operation("claimApproval", Effect.gen(function*() {
      const at = now()
      return (yield* changed(
        `UPDATE gateway_pending_approval
            SET status = 'executing', decided_at = ?, decided_by = ?
          WHERE tenant_id = ? AND id = ? AND status = 'pending' AND expires_at > ?
          RETURNING id`,
        [at, input.decidedBy, input.tenantId, input.id, at]
      )) === 1
    })),

    settleApproval: (input) => operation("settleApproval", Effect.gen(function*() {
      return (yield* changed(
        `UPDATE gateway_pending_approval
            SET status = ?, decided_at = ?, decided_by = ?, result = ?, error = ?
          WHERE tenant_id = ? AND id = ? AND status = ?
          RETURNING id`,
        [
          input.status,
          now(),
          input.decidedBy,
          input.result === null ? null : sealText(JSON.stringify(input.result)),
          input.error,
          input.tenantId,
          input.id,
          input.status === "approved" ? "executing" : "pending"
        ]
      )) === 1
    })),

    cancelApprovalsForClient: (clientId) => operation("cancelApprovalsForClient", Effect.gen(function*() {
      return yield* changed(
        `UPDATE gateway_pending_approval
            SET status = 'denied', decided_at = ?, decided_by = 'client-revoked'
          WHERE client_id = ? AND status = 'pending'
          RETURNING id`,
        [now(), clientId]
      )
    })),

    recordAudit: (input) => operation("recordAudit", Effect.gen(function*() {
      const connection = input.connection
      yield* run(
        `INSERT INTO gateway_audit
           (id, tenant_id, client_id, alias, tool, owner, subject, integration, connection_name, decision, outcome, message, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.id,
          input.tenantId,
          input.clientId,
          input.alias,
          input.tool,
          connection === null ? null : connection.owner,
          connection === null || connection.owner !== "user" ? null : connection.subject,
          connection === null ? null : connection.integration,
          connection === null ? null : connection.name,
          input.decision,
          input.outcome,
          input.message,
          now()
        ]
      )
      if (input.arguments !== undefined) {
        yield* run(
          "INSERT INTO gateway_audit_arguments (audit_id, arguments, expires_at) VALUES (?, ?, ?)",
          [
            input.id,
            sealText(JSON.stringify(input.arguments.value)),
            millis(input.arguments.expiresAt)
          ]
        )
      }
    })),

    listAudit: (tenantId, options) => operation("listAudit", Effect.gen(function*() {
      const filter = auditFilter(options)
      return (yield* all(
        `SELECT * FROM gateway_audit WHERE tenant_id = ?${filter.where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
        [tenantId, ...filter.args, options.limit ?? 50, options.offset ?? 0]
      )).map(toAuditRecord)
    })),

    countAudit: (tenantId, options) => operation("countAudit", Effect.gen(function*() {
      const filter = auditFilter(options)
      const row = yield* one(
        `SELECT COUNT(*) AS total FROM gateway_audit WHERE tenant_id = ?${filter.where}`,
        [tenantId, ...filter.args]
      )
      return row === undefined ? 0 : Number(row["total"] ?? 0)
    })),

    expireAuditArguments: (at) => operation("expireAuditArguments", Effect.gen(function*() {
      return yield* changed(
        "DELETE FROM gateway_audit_arguments WHERE expires_at <= ? RETURNING audit_id",
        [millis(at)]
      )
    })),

    putToolSnapshots: (tenantId, snapshots) => operation("putToolSnapshots", Effect.gen(function*() {
      for (const snapshot of snapshots) {
        yield* run(
          `INSERT INTO gateway_tool_snapshot
             (tenant_id, integration, connection_name, tool, input_schema, output_schema, synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (tenant_id, integration, connection_name, tool) DO UPDATE SET
             input_schema = excluded.input_schema,
             output_schema = excluded.output_schema,
             synced_at = excluded.synced_at`,
          [
            tenantId,
            snapshot.integration,
            snapshot.connection,
            snapshot.tool,
            snapshot.inputSchema === null ? null : JSON.stringify(snapshot.inputSchema),
            snapshot.outputSchema === null ? null : JSON.stringify(snapshot.outputSchema),
            millis(snapshot.syncedAt)
          ]
        )
      }
    })),

    listToolSnapshots: (tenantId, integration) => operation("listToolSnapshots", Effect.gen(function*() {
      return (yield* all(
        "SELECT * FROM gateway_tool_snapshot WHERE tenant_id = ? AND integration = ? ORDER BY connection_name, tool",
        [tenantId, integration]
      )).map(toSnapshot)
    })),

    forgetToolSnapshots: (tenantId, keys) => operation("forgetToolSnapshots", Effect.gen(function*() {
      for (const key of keys) {
        yield* run(
          `DELETE FROM gateway_tool_snapshot
             WHERE tenant_id = ? AND integration = ? AND connection_name = ? AND tool = ?`,
          [tenantId, key.integration, key.connection, key.tool]
        )
      }
    })),

    expireApprovals: (at) => operation("expireApprovals", Effect.gen(function*() {
      return yield* changed(
        `UPDATE gateway_pending_approval
            SET status = 'expired', decided_at = ?,
                error = 'expired before a decision was recorded'
          WHERE status = 'pending' AND expires_at <= ?
          RETURNING id`,
        [now(), millis(at)]
      )
    })),

    // The SqlClient owns the connection; closing it is the scope's business.
    close: () => operation("close", Effect.void)
  }
})

/**
 * Which sort of failure this was. The driver classifies constraint violations
 * for us, so the distinction no longer depends on matching driver text.
 */
const failureKind = (error: SqlError.SqlError): GatewayStoreFailureKind =>
  error.reason._tag === "ConstraintError" || error.reason._tag === "UniqueViolation"
    ? "constraint"
    : "driver"

/**
 * Names what a statement was for. Every store method wraps itself, so the
 * operation appears in the span and in the error without a second mirror of
 * the interface restating it.
 */
const operation = <Success>(
  name: string,
  effect: Effect.Effect<Success, SqlError.SqlError | GatewayStoreError, never>
): Effect.Effect<Success, GatewayStoreError> =>
  effect.pipe(
    Effect.mapError((cause) =>
      cause instanceof GatewayStoreError
        ? cause
        : new GatewayStoreError({ operation: name, kind: failureKind(cause), cause })
    ),
    Effect.withSpan(`GatewayStore.${name}`)
  )

export interface GatewayStoreOptions {
  /** Where the gateway's tables live, when it is not this machine's file. */
  readonly sqlClient?: Layer.Layer<SqlClient.SqlClient>
}

/** The gateway's own SQLite file, opened with the pragmas it relies on. */
export const libsqlLayer = (databasePath: string): Layer.Layer<SqlClient.SqlClient> =>
  Layer.unwrap(Effect.sync(() => {
    mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 })
    return LibsqlClient.layer({ url: `file:${databasePath}` })
  })).pipe(Layer.provide(Reactivity.layer))

const applyPragmas = Effect.fn("GatewayStore.pragmas")(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql.unsafe("PRAGMA journal_mode = WAL")
  yield* sql.unsafe("PRAGMA foreign_keys = ON")
})

export const createGatewayStore = Effect.fn("GatewayStore.open")(function*(
  databasePath: string,
  encryption?: Encryption,
  options: GatewayStoreOptions = {}
): Effect.fn.Return<GatewayStore, GatewayStoreError> {
  // The store owns the connection's scope so that closing the store closes
  // the client, which is the lifecycle every caller already relies on. The
  // layer is built into that scope rather than around a single effect, so the
  // connection outlives the call that opened it.
  const scope = yield* Scope.make()
  const client = options.sqlClient ?? libsqlLayer(databasePath)
  const store = yield* Effect.gen(function*() {
    const context = yield* Layer.buildWithScope(client, scope)
    return yield* operation(
      "open",
      Effect.provide(
        Effect.andThen(applyPragmas(), createGatewayStoreDriver(databasePath, encryption)),
        context
      )
    )
  }).pipe(Effect.onError(() => Scope.close(scope, Exit.void)))

  return {
    ...store,
    close: () => Effect.andThen(store.close(), Scope.close(scope, Exit.void))
  }
})
