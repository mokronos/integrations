import { mkdirSync } from "node:fs"
import path from "node:path"
import { createClient } from "@libsql/client"
import type { Client as LibsqlClient, InValue, Row } from "@libsql/client"
import { Context, Effect, Layer } from "effect"
import type { Encryption } from "./crypto.ts"
import {
  AccessProfileId,
  canonicalArguments,
  ApprovalPolicyId,
  ClientId,
  defaultApprovalDelivery,
  defaultTenantId,
  SessionTokenHash,
  TenantId
} from "./domain.ts"
import type {
  AuthSession,
  Client,
  PendingApproval
} from "./domain.ts"
import { applyGatewayMigrations } from "./migrate.ts"

import {
  millis, toAccessProfile, toAccessProfileTool, toApiKey, toApproval,
  toApprovalPolicy, toApprovalPolicyTool, toAuditRecord, toAuthSession, toClient,
  toExternalIdentity, toIdentityOAuthState, toLoginHandoff, toLoginRecord,
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
  type AuditQuery,
  type GatewayStore,
  type GatewayStoreDriver
} from "./store-contract.ts"

/** Scoped access to the gateway database. Only the private libsql driver is
 * Promise-based; consumers compose typed store failures in Effect. */
export class GatewayStoreService extends Context.Service<
  GatewayStoreService,
  GatewayStore
>()("@mokronos/integrations/GatewayStore") {
  static readonly layer = (
    databasePath: string,
    encryption?: Encryption,
    options?: GatewayStoreOptions
  ): Layer.Layer<GatewayStoreService, GatewayStoreError> =>
    Layer.effect(
      GatewayStoreService,
      Effect.acquireRelease(
        createGatewayStore(databasePath, encryption, options),
        (store) => store.close().pipe(Effect.orDie)
      )
    )
}

const now = (): number => Date.now()
const identity = (text: string): string => text

/** The tenant a single-user gateway is implicitly working in, and its default
 *  policy. Written on every open because it is cheap and idempotent, and
 *  because a gateway with no tenant has nowhere to put a client. Every other
 *  tenant gets both from `createTenant`. */
const bootstrapDefaultTenant = async (database: LibsqlClient): Promise<void> => {
  const timestamp = now()
  await database.execute({
    sql: "INSERT INTO gateway_tenant (id, name, created_at) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING",
    args: [defaultTenantId, "Default", timestamp]
  })
  await database.execute({
    sql: `INSERT INTO gateway_access_profile (id, tenant_id, name, is_default, created_at, updated_at)
          VALUES (?, ?, 'Default', 1, ?, ?)
          ON CONFLICT (id) DO NOTHING`,
    args: [`default-access-profile:${defaultTenantId}`, defaultTenantId, timestamp, timestamp]
  })
  await database.execute({
    sql: `INSERT INTO gateway_approval_policy (id, tenant_id, name, is_default, created_at, updated_at)
          VALUES (?, ?, 'Default', 1, ?, ?)
          ON CONFLICT (id) DO NOTHING`,
    args: [`default-approval-policy:${defaultTenantId}`, defaultTenantId, timestamp, timestamp]
  })
}

/** One filter builder for both the page and its total, so a listing can never
 *  report a count that belongs to a different question than the rows. */
/** A composed SQL fragment and the values it binds, kept together so a caller
 *  cannot pass one without the other. */
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
  // A bare conjunction rather than a full clause: every reader prepends its
  // own tenant scoping with `WHERE tenant_id = ?`.
  return {
    where: clauses.length === 0 ? "" : ` AND ${clauses.join(" AND ")}`,
    args
  }
}

/** Overrides for where the gateway database actually lives. Everything unset
 *  keeps the historical behaviour: one SQLite file under `home`. */
export interface GatewayStoreOptions {
  /** A caller-built client. When present, the store skips creating its own
   *  file-backed client and the engine-level pragmas — the caller owns the
   *  storage engine and its setup (e.g. a D1 binding on Workers). */
  readonly client?: LibsqlClient
}

const openFileDatabase = async (databasePath: string): Promise<LibsqlClient> => {
  mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 })
  const database: LibsqlClient = createClient({ url: `file:${databasePath}` })
  await database.execute("PRAGMA journal_mode = WAL")
  await database.execute("PRAGMA foreign_keys = ON")
  return database
}

const createGatewayStoreDriver = async (
  databasePath: string,
  encryption?: Encryption,
  options: GatewayStoreOptions = {}
): Promise<GatewayStoreDriver> => {
  const database: LibsqlClient =
    options.client ?? await openFileDatabase(databasePath)
  // Generated SQL, embedded at generate time, carries this database from
  // whatever shape it is on to the one db/schema.ts declares. A D1 binding runs
  // the same statements as a local file — see migrate.ts.
  await applyGatewayMigrations(database)
  await bootstrapDefaultTenant(database)

  const one = async (sql: string, args: ReadonlyArray<InValue>): Promise<Row | undefined> => {
    const result = await database.execute({ sql, args: [...args] })
    return result.rows[0]
  }

  const all = async (sql: string, args: ReadonlyArray<InValue>): Promise<ReadonlyArray<Row>> => {
    const result = await database.execute({ sql, args: [...args] })
    return result.rows
  }

  const run = async (sql: string, args: ReadonlyArray<InValue>): Promise<void> => {
    await database.execute({ sql, args: [...args] })
  }

  const requireClient = async (id: ClientId): Promise<Client> => {
    const row = await one("SELECT * FROM gateway_client WHERE id = ?", [id])
    if (row === undefined) throw new Error(`Unknown client ${id}`)
    return toClient(row)
  }

  // --- payload sealing --------------------------------------------------------
  // Approval arguments/results and audit arguments are where caller data (and
  // therefore PII) lives. When a master key is configured they are sealed at
  // rest; reads open them, and rows written before encryption stay readable
  // because `open` passes plaintext through.

  const sealText = (text: string): string =>
    encryption === undefined ? text : encryption.seal(text)
  const openApproval = (row: Row): PendingApproval =>
    toApproval(row, encryption === undefined ? identity : encryption.open)

  const requireSession = async (tokenHash: SessionTokenHash): Promise<AuthSession> => {
    const row = await one(
      `SELECT gateway_session.*, gateway_login.email
         FROM gateway_session JOIN gateway_login ON gateway_login.subject_id = gateway_session.subject_id
        WHERE gateway_session.token_hash = ?`,
      [tokenHash]
    )
    if (row === undefined) throw new Error(`Failed to store session`)
    return toAuthSession(row)
  }

  return {
    databasePath,

    createTenant: async (input) => {
      const id = input?.id ?? TenantId.make(crypto.randomUUID())
      const name = input?.name ?? "Untitled"
      await database.execute("BEGIN IMMEDIATE")
      try {
        await run(
          "INSERT INTO gateway_tenant (id, name, created_at) VALUES (?, ?, ?)",
          [id, name, now()]
        )
        const timestamp = now()
        await run(
         `INSERT INTO gateway_access_profile (id, tenant_id, name, is_default, created_at, updated_at)
           VALUES (?, ?, 'Default', 1, ?, ?)`,
          [AccessProfileId.make(`default-access-profile:${id}`), id, timestamp, timestamp]
        )
        await run(
          `INSERT INTO gateway_approval_policy (id, tenant_id, name, is_default, created_at, updated_at)
           VALUES (?, ?, 'Default', 1, ?, ?)`,
          [ApprovalPolicyId.make(`default-approval-policy:${id}`), id, timestamp, timestamp]
        )
        await database.execute("COMMIT")
      } catch (cause) {
        await database.execute("ROLLBACK")
        throw cause
      }
      const row = await one("SELECT * FROM gateway_tenant WHERE id = ?", [id])
      if (row === undefined) throw new Error(`Failed to store tenant ${id}`)
      return toTenant(row)
    },

    listTenants: async () =>
      (await all("SELECT * FROM gateway_tenant ORDER BY created_at", [])).map(toTenant),

    findTenantById: async (id) => {
      const row = await one("SELECT * FROM gateway_tenant WHERE id = ?", [id])
      return row === undefined ? undefined : toTenant(row)
    },

    findTenantByName: async (name) => {
      const row = await one("SELECT * FROM gateway_tenant WHERE name = ?", [name])
      return row === undefined ? undefined : toTenant(row)
    },

    createSubject: async (input) => {
      await run(
        "INSERT INTO gateway_subject (id, tenant_id, created_at) VALUES (?, ?, ?)",
        [input.id, input.tenantId, now()]
      )
      const row = await one("SELECT * FROM gateway_subject WHERE id = ?", [input.id])
      if (row === undefined) throw new Error(`Failed to store subject ${input.id}`)
      return toSubject(row)
    },

    listSubjects: async (tenantId) =>
      (await all(
        "SELECT * FROM gateway_subject WHERE tenant_id = ? ORDER BY created_at",
        [tenantId]
      )).map(toSubject),

    countSubjects: async (tenantId) => {
      const row = await one(
        "SELECT COUNT(*) AS total FROM gateway_subject WHERE tenant_id = ?",
        [tenantId]
      )
      return row === undefined ? 0 : Number(row["total"] ?? 0)
    },

    findSubjectById: async (id) => {
      const row = await one("SELECT * FROM gateway_subject WHERE id = ?", [id])
      return row === undefined ? undefined : toSubject(row)
    },

    createLogin: async (input) => {
      await run(
        "INSERT INTO gateway_login (subject_id, tenant_id, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)",
        [input.subjectId, input.tenantId, input.email, input.passwordHash, now()]
      )
      const row = await one("SELECT * FROM gateway_login WHERE subject_id = ?", [input.subjectId])
      if (row === undefined) throw new Error(`Failed to store login for ${input.email}`)
      return toLoginRecord(row)
    },

    findLoginByEmail: async (email) => {
      const row = await one("SELECT * FROM gateway_login WHERE email = ?", [email])
      return row === undefined ? undefined : toLoginRecord(row)
    },

    findLoginBySubject: async (subjectId) => {
      const row = await one("SELECT * FROM gateway_login WHERE subject_id = ?", [subjectId])
      return row === undefined ? undefined : toLoginRecord(row)
    },

    countLogins: async () => {
      const row = await one("SELECT COUNT(*) AS total FROM gateway_login", [])
      return row === undefined ? 0 : Number(row["total"] ?? 0)
    },

    changeLoginEmail: async (subjectId, email) => {
      await run("UPDATE gateway_login SET email = ? WHERE subject_id = ?", [email, subjectId])
    },

    changeLoginPassword: async (subjectId, passwordHash) => {
      await run("UPDATE gateway_login SET password_hash = ? WHERE subject_id = ?", [
        passwordHash,
        subjectId
      ])
    },

    deleteSubject: async (subjectId) => {
      // The cascade takes the login and every session with it — the store's
      // own DDL declares login and session as children of the subject.
      await run("DELETE FROM gateway_subject WHERE id = ?", [subjectId])
    },

    deleteTenant: async (id) => {
      // Every tenant-scoped table declares ON DELETE CASCADE, so one delete
      // reclaims clients, keys, policies, bindings, approvals, audit rows, and snapshots.
      await run("DELETE FROM gateway_tenant WHERE id = ?", [id])
    },

    revokeSubjectSessions: async (subjectId, exceptTokenHash) => {
      const result =
        exceptTokenHash === undefined
          ? await database.execute({
            sql: "DELETE FROM gateway_session WHERE subject_id = ?",
            args: [subjectId]
          })
          : await database.execute({
            sql: "DELETE FROM gateway_session WHERE subject_id = ? AND token_hash != ?",
            args: [subjectId, exceptTokenHash]
          })
      return Number(result.rowsAffected)
    },

    createSession: async (input) => {
      await run(
        "INSERT INTO gateway_session (token_hash, subject_id, tenant_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
        [input.tokenHash, input.subjectId, input.tenantId, now(), millis(input.expiresAt)]
      )
      return await requireSession(input.tokenHash)
    },

    // Joined with the login for the display email; expired rows read as absent.
    findLiveSession: async (tokenHash) => {
      const row = await one(
        `SELECT gateway_session.*, gateway_login.email
           FROM gateway_session JOIN gateway_login ON gateway_login.subject_id = gateway_session.subject_id
          WHERE gateway_session.token_hash = ? AND gateway_session.expires_at > ?`,
        [tokenHash, now()]
      )
      return row === undefined ? undefined : toAuthSession(row)
    },

    revokeSession: async (tokenHash) => {
      await run("DELETE FROM gateway_session WHERE token_hash = ?", [tokenHash])
    },

    deleteExpiredSessions: async (at) => {
      const result = await database.execute({
        sql: "DELETE FROM gateway_session WHERE expires_at <= ?",
        args: [millis(at)]
      })
      return Number(result.rowsAffected)
    },

    createExternalIdentity: async (input) => {
      await run(
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
      const row = await one(
        "SELECT * FROM gateway_external_identity WHERE provider = ? AND provider_subject = ?",
        [input.provider, input.providerSubject]
      )
      if (row === undefined) throw new Error(`Failed to store ${input.provider} identity`)
      return toExternalIdentity(row)
    },

    findExternalIdentity: async (provider, providerSubject) => {
      const row = await one(
        "SELECT * FROM gateway_external_identity WHERE provider = ? AND provider_subject = ?",
        [provider, providerSubject]
      )
      return row === undefined ? undefined : toExternalIdentity(row)
    },

    listExternalIdentities: async (subjectId) =>
      (await all(
        "SELECT * FROM gateway_external_identity WHERE subject_id = ? ORDER BY created_at",
        [subjectId]
      )).map(toExternalIdentity),

    createLoginHandoff: async (input) => {
      await run(
        `INSERT INTO gateway_login_handoff
           (request_hash, subject_id, tenant_id, email, created_at, expires_at, collected_at)
         VALUES (?, NULL, NULL, NULL, ?, ?, NULL)`,
        [input.requestHash, now(), millis(input.expiresAt)]
      )
      const row = await one(
        "SELECT * FROM gateway_login_handoff WHERE request_hash = ?",
        [input.requestHash]
      )
      if (row === undefined) throw new Error("Failed to store login handoff")
      return toLoginHandoff(row)
    },

    getLoginHandoff: async (requestHash) => {
      const row = await one(
        "SELECT * FROM gateway_login_handoff WHERE request_hash = ?",
        [requestHash]
      )
      return row === undefined ? undefined : toLoginHandoff(row)
    },

    completeLoginHandoff: async (input) => {
      const result = await database.execute({
        sql: `UPDATE gateway_login_handoff
                SET subject_id = ?, tenant_id = ?, email = ?
              WHERE request_hash = ? AND collected_at IS NULL AND expires_at > ?`,
        args: [input.subjectId, input.tenantId, input.email, input.requestHash, now()]
      })
      return Number(result.rowsAffected) > 0
    },

    collectLoginHandoff: async (requestHash) => {
      const result = await database.execute({
        sql: `UPDATE gateway_login_handoff SET collected_at = ?
               WHERE request_hash = ? AND subject_id IS NOT NULL
                 AND collected_at IS NULL AND expires_at > ?`,
        args: [now(), requestHash, now()]
      })
      return Number(result.rowsAffected) > 0
    },

    createIdentityOAuthState: async (input) => {
      await run(
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
    },

    consumeIdentityOAuthState: async (stateHash) => {
      const result = await database.execute({
        sql: `DELETE FROM gateway_identity_oauth_state
               WHERE state_hash = ? AND expires_at > ?
               RETURNING *`,
        args: [stateHash, now()]
      })
      const row = result.rows[0]
      if (row === undefined) {
        await run("DELETE FROM gateway_identity_oauth_state WHERE state_hash = ?", [stateHash])
      }
      return row === undefined ? undefined : toIdentityOAuthState(row)
    },

    deleteExpiredIdentityFlows: async (at) => {
      const expiresAt = millis(at)
      const states = await database.execute({
        sql: "DELETE FROM gateway_identity_oauth_state WHERE expires_at <= ?",
        args: [expiresAt]
      })
      const handoffs = await database.execute({
        sql: "DELETE FROM gateway_login_handoff WHERE expires_at <= ?",
        args: [expiresAt]
      })
      return Number(states.rowsAffected) + Number(handoffs.rowsAffected)
    },

    createClient: async (input) => {
      await run(
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
      return await requireClient(input.id)
    },

    listClients: async (tenantId) =>
      (await all(
        "SELECT * FROM gateway_client WHERE tenant_id = ? ORDER BY created_at",
        [tenantId]
      )).map(toClient),

    overviewCounts: async (tenantId) => {
      const row = await one(
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
    },

    findClientById: async (tenantId, id) => {
      const row = await one(
        "SELECT * FROM gateway_client WHERE tenant_id = ? AND id = ?",
        [tenantId, id]
      )
      return row === undefined ? undefined : toClient(row)
    },

    findClientByName: async (tenantId, name) => {
      const row = await one(
        "SELECT * FROM gateway_client WHERE tenant_id = ? AND name = ?",
        [tenantId, name]
      )
      return row === undefined ? undefined : toClient(row)
    },

    updateClientSettings: async (input) => {
      await run(
        `UPDATE gateway_client SET capabilities = ?, approval_delivery = ?
          WHERE tenant_id = ? AND id = ? AND revoked_at IS NULL`,
        [
          JSON.stringify(input.capabilities),
          JSON.stringify(input.approvalDelivery),
          input.tenantId,
          input.id
        ]
      )
      return await requireClient(input.id)
    },

    revokeClient: async (tenantId, id) => {
      await run(
        "UPDATE gateway_client SET revoked_at = ? WHERE tenant_id = ? AND id = ? AND revoked_at IS NULL",
        [now(), tenantId, id]
      )
    },

    addApiKey: async (input) => {
      await run(
        "INSERT INTO gateway_api_key (id, client_id, hash, created_at, last_used_at, revoked_at) VALUES (?, ?, ?, ?, NULL, NULL)",
        [input.id, input.clientId, input.hash, now()]
      )
      const row = await one("SELECT * FROM gateway_api_key WHERE id = ?", [input.id])
      if (row === undefined) throw new Error(`Failed to store API key ${input.id}`)
      return toApiKey(row)
    },

    listApiKeys: async (clientId) =>
      (await all("SELECT * FROM gateway_api_key WHERE client_id = ? ORDER BY created_at", [clientId]))
        .map(toApiKey),

    findApiKeyByHash: async (hash) => {
      const row = await one(
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
          // The joined client columns shadow what the key row carries; every
          // client field must come from its aliased column, including id.
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
    },

    touchApiKey: async (id) => {
      await run("UPDATE gateway_api_key SET last_used_at = ? WHERE id = ?", [now(), id])
    },

    revokeApiKey: async (id) => {
      await run("UPDATE gateway_api_key SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", [now(), id])
    },

    createAccessProfile: async (input) => {
      const timestamp = now()
      await run(
        `INSERT INTO gateway_access_profile (id, tenant_id, name, is_default, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          input.id, input.tenantId, input.name, input.isDefault === true ? 1 : 0, timestamp, timestamp
        ]
      )
      const row = await one("SELECT * FROM gateway_access_profile WHERE id = ?", [input.id])
      if (row === undefined) throw new Error(`Failed to store access profile ${input.id}`)
      return toAccessProfile(row)
    },

    updateAccessProfile: async (tenantId, id, name) => {
      await run(
        "UPDATE gateway_access_profile SET name = ?, updated_at = ? WHERE tenant_id = ? AND id = ?",
        [name, now(), tenantId, id]
      )
      const row = await one("SELECT * FROM gateway_access_profile WHERE tenant_id = ? AND id = ?", [tenantId, id])
      if (row === undefined) throw new Error(`Unknown access profile ${id}`)
      return toAccessProfile(row)
    },

    deleteAccessProfile: async (tenantId, id) => {
      const result = await database.execute({
        sql: `DELETE FROM gateway_access_profile
               WHERE tenant_id = ? AND id = ? AND is_default = 0
                  AND NOT EXISTS (SELECT 1 FROM gateway_client WHERE access_profile_id = ?)`,
        args: [tenantId, id, id]
      })
      if (Number(result.rowsAffected) === 0) {
        throw new Error(`Access profile ${id} is default, assigned, or does not exist`)
      }
    },

    listAccessProfiles: async (tenantId) =>
      (await all("SELECT * FROM gateway_access_profile WHERE tenant_id = ? ORDER BY is_default DESC, name", [tenantId])).map(toAccessProfile),

    findAccessProfile: async (tenantId, id) => {
      const row = await one("SELECT * FROM gateway_access_profile WHERE tenant_id = ? AND id = ?", [tenantId, id])
      return row === undefined ? undefined : toAccessProfile(row)
    },

    findDefaultAccessProfile: async (tenantId) => {
      const row = await one("SELECT * FROM gateway_access_profile WHERE tenant_id = ? AND is_default = 1", [tenantId])
      return row === undefined ? undefined : toAccessProfile(row)
    },

    findAccessProfileForClient: async (clientId) => {
      const row = await one(
        `SELECT profile.* FROM gateway_access_profile AS profile
           JOIN gateway_client AS client ON client.access_profile_id = profile.id
           WHERE client.id = ?`,
        [clientId]
      )
      return row === undefined ? undefined : toAccessProfile(row)
    },

    listAccessProfileTools: async (id) =>
      (await all("SELECT * FROM gateway_access_profile_tool WHERE access_profile_id = ? ORDER BY integration, connection_name, tool", [id])).map(toAccessProfileTool),

    replaceAccessProfileTools: async (id, tools) => {
      await database.execute("BEGIN IMMEDIATE")
      try {
        await run("DELETE FROM gateway_access_profile_tool WHERE access_profile_id = ?", [id])
        for (const tool of tools) {
          await run(
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
        await run(
          `UPDATE gateway_access_profile
              SET updated_at = CASE WHEN updated_at >= ? THEN updated_at + 1 ELSE ? END
            WHERE id = ?`,
          [now(), now(), id]
        )
        await database.execute("COMMIT")
      } catch (cause) {
        await database.execute("ROLLBACK")
        throw cause
      }
      return (await all("SELECT * FROM gateway_access_profile_tool WHERE access_profile_id = ? ORDER BY integration, connection_name, tool", [id])).map(toAccessProfileTool)
    },

    assignAccessProfile: async (tenantId, clientId, id) => {
      const result = await database.execute({
        sql: `UPDATE gateway_client SET access_profile_id = ?
               WHERE tenant_id = ? AND id = ? AND EXISTS (
                  SELECT 1 FROM gateway_access_profile WHERE id = ? AND tenant_id = ?
                )`,
        args: [id, tenantId, clientId, id, tenantId]
      })
      if (Number(result.rowsAffected) === 0) throw new Error(`Access profile ${id} cannot be assigned to client ${clientId}`)
      return await requireClient(clientId)
    },

    createApprovalPolicy: async (input) => {
      const timestamp = now()
      await run(
        `INSERT INTO gateway_approval_policy (id, tenant_id, name, is_default, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [input.id, input.tenantId, input.name, input.isDefault === true ? 1 : 0, timestamp, timestamp]
      )
      const row = await one("SELECT * FROM gateway_approval_policy WHERE id = ?", [input.id])
      if (row === undefined) throw new Error(`Failed to store approval policy ${input.id}`)
      return toApprovalPolicy(row)
    },

    updateApprovalPolicy: async (tenantId, id, name) => {
      await run("UPDATE gateway_approval_policy SET name = ?, updated_at = ? WHERE tenant_id = ? AND id = ?", [name, now(), tenantId, id])
      const row = await one("SELECT * FROM gateway_approval_policy WHERE tenant_id = ? AND id = ?", [tenantId, id])
      if (row === undefined) throw new Error(`Unknown approval policy ${id}`)
      return toApprovalPolicy(row)
    },

    deleteApprovalPolicy: async (tenantId, id) => {
      const result = await database.execute({
        sql: `DELETE FROM gateway_approval_policy WHERE tenant_id = ? AND id = ? AND is_default = 0
              AND NOT EXISTS (SELECT 1 FROM gateway_client WHERE approval_policy_id = ?)`,
        args: [tenantId, id, id]
      })
      if (Number(result.rowsAffected) === 0) throw new Error(`Approval policy ${id} is default, assigned, or does not exist`)
    },

    listApprovalPolicies: async (tenantId) =>
      (await all("SELECT * FROM gateway_approval_policy WHERE tenant_id = ? ORDER BY is_default DESC, name", [tenantId])).map(toApprovalPolicy),

    findApprovalPolicy: async (tenantId, id) => {
      const row = await one("SELECT * FROM gateway_approval_policy WHERE tenant_id = ? AND id = ?", [tenantId, id])
      return row === undefined ? undefined : toApprovalPolicy(row)
    },

    findDefaultApprovalPolicy: async (tenantId) => {
      const row = await one("SELECT * FROM gateway_approval_policy WHERE tenant_id = ? AND is_default = 1", [tenantId])
      return row === undefined ? undefined : toApprovalPolicy(row)
    },

    findApprovalPolicyForClient: async (clientId) => {
      const row = await one(`SELECT policy.* FROM gateway_approval_policy AS policy
        JOIN gateway_client AS client ON client.approval_policy_id = policy.id WHERE client.id = ?`, [clientId])
      return row === undefined ? undefined : toApprovalPolicy(row)
    },

    listApprovalPolicyTools: async (id) =>
      (await all("SELECT * FROM gateway_approval_policy_tool WHERE approval_policy_id = ? ORDER BY integration, connection_name, tool", [id])).map(toApprovalPolicyTool),

    replaceApprovalPolicyTools: async (id, tools) => {
      await database.execute("BEGIN IMMEDIATE")
      try {
        await run("DELETE FROM gateway_approval_policy_tool WHERE approval_policy_id = ?", [id])
        for (const tool of tools) {
          await run(`INSERT INTO gateway_approval_policy_tool
            (approval_policy_id, owner, subject, integration, connection_name, tool, decision)
            VALUES (?, ?, ?, ?, ?, ?, ?)`, [
            id, tool.connection.owner, tool.connection.owner === "user" ? tool.connection.subject : null,
            tool.connection.integration, tool.connection.name, tool.tool, tool.decision
          ])
        }
        await run(`UPDATE gateway_approval_policy SET updated_at = CASE WHEN updated_at >= ? THEN updated_at + 1 ELSE ? END WHERE id = ?`, [now(), now(), id])
        await database.execute("COMMIT")
      } catch (cause) {
        await database.execute("ROLLBACK")
        throw cause
      }
      return (await all("SELECT * FROM gateway_approval_policy_tool WHERE approval_policy_id = ? ORDER BY integration, connection_name, tool", [id])).map(toApprovalPolicyTool)
    },

    assignApprovalPolicy: async (tenantId, clientId, id) => {
      const result = await database.execute({
        sql: `UPDATE gateway_client SET approval_policy_id = ? WHERE tenant_id = ? AND id = ? AND EXISTS (
          SELECT 1 FROM gateway_approval_policy WHERE id = ? AND tenant_id = ?)`,
        args: [id, tenantId, clientId, id, tenantId]
      })
      if (Number(result.rowsAffected) === 0) throw new Error(`Approval policy ${id} cannot be assigned to client ${clientId}`)
      return await requireClient(clientId)
    },

    createApproval: async (input) => {
      // Stored canonically so that the same request, however its JSON was
      // built, matches the frozen call it is a retry of — then sealed. The
      // keyed digest of the canonical text rides alongside, because equality
      // search over randomised ciphertext is impossible by design.
      const canonical = canonicalArguments(input.arguments)
      await run(
        `INSERT INTO gateway_pending_approval
           (id, tenant_id, client_id, approval_policy_id, access_profile_id, alias, tool, arguments, arguments_lookup, status, created_at, expires_at, decided_at, decided_by, result, error, collected_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL, NULL, NULL, NULL, NULL)`,
        [
          input.id,
          input.tenantId,
          input.clientId,
          input.approvalPolicyId,
          input.accessProfileId,
          input.alias,
          input.tool,
          sealText(canonical),
          encryption === undefined ? null : encryption.lookup(canonical),
          now(),
          millis(input.expiresAt)
        ]
      )
      const row = await one("SELECT * FROM gateway_pending_approval WHERE id = ?", [input.id])
      if (row === undefined) throw new Error(`Failed to store approval ${input.id}`)
      return openApproval(row)
    },

    findUncollectedApproval: async (approvalPolicyId, accessProfileId, tool, argumentsValue) => {
      const canonical = canonicalArguments(argumentsValue)
      const row = await one(
        `SELECT * FROM gateway_pending_approval
          WHERE approval_policy_id = ? AND access_profile_id = ? AND tool = ?
            AND ((arguments_lookup IS NOT NULL AND arguments_lookup = ?)
              OR (arguments_lookup IS NULL AND arguments = ?))
            AND collected_at IS NULL
          ORDER BY created_at DESC LIMIT 1`,
        [
          approvalPolicyId,
          accessProfileId,
          tool,
          encryption === undefined ? canonical : encryption.lookup(canonical),
          canonical
        ]
      )
      return row === undefined ? undefined : openApproval(row)
    },

    collectApproval: async (tenantId, id) => {
      const result = await database.execute({
        sql: `UPDATE gateway_pending_approval
                SET collected_at = ?
              WHERE tenant_id = ? AND id = ? AND collected_at IS NULL AND status <> 'pending'`,
        args: [now(), tenantId, id]
      })
      return Number(result.rowsAffected) > 0
    },

    getApproval: async (tenantId, id) => {
      const row = await one(
        "SELECT * FROM gateway_pending_approval WHERE tenant_id = ? AND id = ?",
        [tenantId, id]
      )
      return row === undefined ? undefined : openApproval(row)
    },

    listApprovals: async (tenantId, status) =>
      (status === undefined
        ? await all(
          "SELECT * FROM gateway_pending_approval WHERE tenant_id = ? ORDER BY created_at DESC",
          [tenantId]
        )
        : await all(
          "SELECT * FROM gateway_pending_approval WHERE tenant_id = ? AND status = ? ORDER BY created_at DESC",
          [tenantId, status]
        )).map(openApproval),

    settleApproval: async (input) => {
      await run(
        `UPDATE gateway_pending_approval
            SET status = ?, decided_at = ?, decided_by = ?, result = ?, error = ?
          WHERE tenant_id = ? AND id = ? AND status = 'pending'`,
        [
          input.status,
          now(),
          input.decidedBy,
          input.result === null ? null : sealText(JSON.stringify(input.result)),
          input.error,
          input.tenantId,
          input.id
        ]
      )
    },

    cancelApprovalsForClient: async (clientId) => {
      const result = await database.execute({
        sql: `UPDATE gateway_pending_approval
                SET status = 'denied', decided_at = ?, decided_by = 'client-revoked'
              WHERE client_id = ? AND status = 'pending'`,
        args: [now(), clientId]
      })
      return Number(result.rowsAffected)
    },

    recordAudit: async (input) => {
      const connection = input.connection
      await run(
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
        await run(
          "INSERT INTO gateway_audit_arguments (audit_id, arguments, expires_at) VALUES (?, ?, ?)",
          [
            input.id,
            sealText(JSON.stringify(input.arguments.value)),
            millis(input.arguments.expiresAt)
          ]
        )
      }
    },

    listAudit: async (tenantId, options) => {
      const filter = auditFilter(options)
      return (await all(
        `SELECT * FROM gateway_audit WHERE tenant_id = ?${filter.where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
        [tenantId, ...filter.args, options.limit ?? 50, options.offset ?? 0]
      )).map(toAuditRecord)
    },

    countAudit: async (tenantId, options) => {
      const filter = auditFilter(options)
      const row = await one(
        `SELECT COUNT(*) AS total FROM gateway_audit WHERE tenant_id = ?${filter.where}`,
        [tenantId, ...filter.args]
      )
      return row === undefined ? 0 : Number(row["total"] ?? 0)
    },

    expireAuditArguments: async (at) => {
      const result = await database.execute({
        sql: "DELETE FROM gateway_audit_arguments WHERE expires_at <= ?",
        args: [millis(at)]
      })
      return Number(result.rowsAffected)
    },

    putToolSnapshots: async (tenantId, snapshots) => {
      for (const snapshot of snapshots) {
        await run(
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
    },

    listToolSnapshots: async (tenantId, integration) =>
      (await all(
        "SELECT * FROM gateway_tool_snapshot WHERE tenant_id = ? AND integration = ? ORDER BY connection_name, tool",
        [tenantId, integration]
      )).map(toSnapshot),

    forgetToolSnapshots: async (tenantId, keys) => {
      for (const key of keys) {
        await run(
          `DELETE FROM gateway_tool_snapshot
             WHERE tenant_id = ? AND integration = ? AND connection_name = ? AND tool = ?`,
          [tenantId, key.integration, key.connection, key.tool]
        )
      }
    },

    expireApprovals: async (at) => {
      const result = await database.execute({
        sql: `UPDATE gateway_pending_approval
                SET status = 'expired', decided_at = ?, error = 'expired before a decision was recorded'
              WHERE status = 'pending' AND expires_at <= ?`,
        args: [now(), millis(at)]
      })
      return Number(result.rowsAffected)
    },

    close: async () => {
      database.close()
    }
  }
}

const storeOperation = <Success>(
  operation: string,
  run: () => Promise<Success>
): Effect.Effect<Success, GatewayStoreError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new GatewayStoreError({ operation, cause })
  }).pipe(Effect.withSpan(`GatewayStore.${operation}`))

const effectStore = (driver: GatewayStoreDriver): GatewayStore => ({
  databasePath: driver.databasePath,
  createTenant: (input) => storeOperation("createTenant", () => driver.createTenant(input)),
  listTenants: () => storeOperation("listTenants", () => driver.listTenants()),
  findTenantById: (id) => storeOperation("findTenantById", () => driver.findTenantById(id)),
  findTenantByName: (name) => storeOperation("findTenantByName", () => driver.findTenantByName(name)),
  createSubject: (input) => storeOperation("createSubject", () => driver.createSubject(input)),
  listSubjects: (tenantId) => storeOperation("listSubjects", () => driver.listSubjects(tenantId)),
  countSubjects: (tenantId) => storeOperation("countSubjects", () => driver.countSubjects(tenantId)),
  findSubjectById: (id) => storeOperation("findSubjectById", () => driver.findSubjectById(id)),
  createLogin: (input) => storeOperation("createLogin", () => driver.createLogin(input)),
  findLoginByEmail: (email) => storeOperation("findLoginByEmail", () => driver.findLoginByEmail(email)),
  findLoginBySubject: (subjectId) =>
    storeOperation("findLoginBySubject", () => driver.findLoginBySubject(subjectId)),
  countLogins: () => storeOperation("countLogins", () => driver.countLogins()),
  changeLoginEmail: (subjectId, email) =>
    storeOperation("changeLoginEmail", () => driver.changeLoginEmail(subjectId, email)),
  changeLoginPassword: (subjectId, passwordHash) =>
    storeOperation("changeLoginPassword", () => driver.changeLoginPassword(subjectId, passwordHash)),
  deleteSubject: (subjectId) => storeOperation("deleteSubject", () => driver.deleteSubject(subjectId)),
  deleteTenant: (id) => storeOperation("deleteTenant", () => driver.deleteTenant(id)),
  revokeSubjectSessions: (subjectId, exceptTokenHash) =>
    storeOperation(
      "revokeSubjectSessions",
      () => driver.revokeSubjectSessions(subjectId, exceptTokenHash)
    ),
  createSession: (input) => storeOperation("createSession", () => driver.createSession(input)),
  findLiveSession: (tokenHash) =>
    storeOperation("findLiveSession", () => driver.findLiveSession(tokenHash)),
  revokeSession: (tokenHash) => storeOperation("revokeSession", () => driver.revokeSession(tokenHash)),
  deleteExpiredSessions: (at) =>
    storeOperation("deleteExpiredSessions", () => driver.deleteExpiredSessions(at)),
  createExternalIdentity: (input) =>
    storeOperation("createExternalIdentity", () => driver.createExternalIdentity(input)),
  findExternalIdentity: (provider, providerSubject) =>
    storeOperation(
      "findExternalIdentity",
      () => driver.findExternalIdentity(provider, providerSubject)
    ),
  listExternalIdentities: (subjectId) =>
    storeOperation("listExternalIdentities", () => driver.listExternalIdentities(subjectId)),
  createLoginHandoff: (input) =>
    storeOperation("createLoginHandoff", () => driver.createLoginHandoff(input)),
  getLoginHandoff: (requestHash) =>
    storeOperation("getLoginHandoff", () => driver.getLoginHandoff(requestHash)),
  completeLoginHandoff: (input) =>
    storeOperation("completeLoginHandoff", () => driver.completeLoginHandoff(input)),
  collectLoginHandoff: (requestHash) =>
    storeOperation("collectLoginHandoff", () => driver.collectLoginHandoff(requestHash)),
  createIdentityOAuthState: (input) =>
    storeOperation("createIdentityOAuthState", () => driver.createIdentityOAuthState(input)),
  consumeIdentityOAuthState: (stateHash) =>
    storeOperation("consumeIdentityOAuthState", () => driver.consumeIdentityOAuthState(stateHash)),
  deleteExpiredIdentityFlows: (at) =>
    storeOperation("deleteExpiredIdentityFlows", () => driver.deleteExpiredIdentityFlows(at)),
  createClient: (input) => storeOperation("createClient", () => driver.createClient(input)),
  listClients: (tenantId) => storeOperation("listClients", () => driver.listClients(tenantId)),
  overviewCounts: (tenantId) => storeOperation("overviewCounts", () => driver.overviewCounts(tenantId)),
  findClientById: (tenantId, id) =>
    storeOperation("findClientById", () => driver.findClientById(tenantId, id)),
  findClientByName: (tenantId, name) =>
    storeOperation("findClientByName", () => driver.findClientByName(tenantId, name)),
  updateClientSettings: (input) =>
    storeOperation("updateClientSettings", () => driver.updateClientSettings(input)),
  revokeClient: (tenantId, id) =>
    storeOperation("revokeClient", () => driver.revokeClient(tenantId, id)),
  addApiKey: (input) => storeOperation("addApiKey", () => driver.addApiKey(input)),
  listApiKeys: (clientId) => storeOperation("listApiKeys", () => driver.listApiKeys(clientId)),
  findApiKeyByHash: (hash) =>
    storeOperation("findApiKeyByHash", () => driver.findApiKeyByHash(hash)),
  touchApiKey: (id) => storeOperation("touchApiKey", () => driver.touchApiKey(id)),
  revokeApiKey: (id) => storeOperation("revokeApiKey", () => driver.revokeApiKey(id)),
  createAccessProfile: (input) => storeOperation("createAccessProfile", () => driver.createAccessProfile(input)),
  updateAccessProfile: (tenantId, id, name) => storeOperation("updateAccessProfile", () => driver.updateAccessProfile(tenantId, id, name)),
  deleteAccessProfile: (tenantId, id) => storeOperation("deleteAccessProfile", () => driver.deleteAccessProfile(tenantId, id)),
  listAccessProfiles: (tenantId) => storeOperation("listAccessProfiles", () => driver.listAccessProfiles(tenantId)),
  findAccessProfile: (tenantId, id) => storeOperation("findAccessProfile", () => driver.findAccessProfile(tenantId, id)),
  findDefaultAccessProfile: (tenantId) => storeOperation("findDefaultAccessProfile", () => driver.findDefaultAccessProfile(tenantId)),
  findAccessProfileForClient: (clientId) => storeOperation("findAccessProfileForClient", () => driver.findAccessProfileForClient(clientId)),
  listAccessProfileTools: (id) => storeOperation("listAccessProfileTools", () => driver.listAccessProfileTools(id)),
  replaceAccessProfileTools: (id, tools) => storeOperation("replaceAccessProfileTools", () => driver.replaceAccessProfileTools(id, tools)),
  assignAccessProfile: (tenantId, clientId, id) => storeOperation("assignAccessProfile", () => driver.assignAccessProfile(tenantId, clientId, id)),
  createApprovalPolicy: (input) => storeOperation("createApprovalPolicy", () => driver.createApprovalPolicy(input)),
  updateApprovalPolicy: (tenantId, id, name) => storeOperation("updateApprovalPolicy", () => driver.updateApprovalPolicy(tenantId, id, name)),
  deleteApprovalPolicy: (tenantId, id) => storeOperation("deleteApprovalPolicy", () => driver.deleteApprovalPolicy(tenantId, id)),
  listApprovalPolicies: (tenantId) => storeOperation("listApprovalPolicies", () => driver.listApprovalPolicies(tenantId)),
  findApprovalPolicy: (tenantId, id) => storeOperation("findApprovalPolicy", () => driver.findApprovalPolicy(tenantId, id)),
  findDefaultApprovalPolicy: (tenantId) => storeOperation("findDefaultApprovalPolicy", () => driver.findDefaultApprovalPolicy(tenantId)),
  findApprovalPolicyForClient: (clientId) => storeOperation("findApprovalPolicyForClient", () => driver.findApprovalPolicyForClient(clientId)),
  listApprovalPolicyTools: (id) => storeOperation("listApprovalPolicyTools", () => driver.listApprovalPolicyTools(id)),
  replaceApprovalPolicyTools: (id, tools) => storeOperation("replaceApprovalPolicyTools", () => driver.replaceApprovalPolicyTools(id, tools)),
  assignApprovalPolicy: (tenantId, clientId, id) => storeOperation("assignApprovalPolicy", () => driver.assignApprovalPolicy(tenantId, clientId, id)),
  createApproval: (input) => storeOperation("createApproval", () => driver.createApproval(input)),
  getApproval: (tenantId, id) =>
    storeOperation("getApproval", () => driver.getApproval(tenantId, id)),
  listApprovals: (tenantId, status) =>
    storeOperation("listApprovals", () => driver.listApprovals(tenantId, status)),
  findUncollectedApproval: (approvalPolicyId, accessProfileId, tool, argumentsValue) =>
    storeOperation(
      "findUncollectedApproval",
      () => driver.findUncollectedApproval(approvalPolicyId, accessProfileId, tool, argumentsValue)
    ),
  collectApproval: (tenantId, id) =>
    storeOperation("collectApproval", () => driver.collectApproval(tenantId, id)),
  settleApproval: (input) => storeOperation("settleApproval", () => driver.settleApproval(input)),
  cancelApprovalsForClient: (clientId) =>
    storeOperation("cancelApprovalsForClient", () => driver.cancelApprovalsForClient(clientId)),
  recordAudit: (input) => storeOperation("recordAudit", () => driver.recordAudit(input)),
  listAudit: (tenantId, options) =>
    storeOperation("listAudit", () => driver.listAudit(tenantId, options)),
  countAudit: (tenantId, options) =>
    storeOperation("countAudit", () => driver.countAudit(tenantId, options)),
  expireAuditArguments: (at) =>
    storeOperation("expireAuditArguments", () => driver.expireAuditArguments(at)),
  putToolSnapshots: (tenantId, snapshots) =>
    storeOperation("putToolSnapshots", () => driver.putToolSnapshots(tenantId, snapshots)),
  listToolSnapshots: (tenantId, integration) =>
    storeOperation("listToolSnapshots", () => driver.listToolSnapshots(tenantId, integration)),
  forgetToolSnapshots: (tenantId, keys) =>
    storeOperation("forgetToolSnapshots", () => driver.forgetToolSnapshots(tenantId, keys)),
  expireApprovals: (at) => storeOperation("expireApprovals", () => driver.expireApprovals(at)),
  close: () => storeOperation("close", () => driver.close())
})

export const createGatewayStore = Effect.fn("GatewayStore.open")(function*(
  databasePath: string,
  encryption?: Encryption,
  options: GatewayStoreOptions = {}
) {
  const driver = yield* storeOperation(
    "open",
    () => createGatewayStoreDriver(databasePath, encryption, options)
  )
  return effectStore(driver)
})
