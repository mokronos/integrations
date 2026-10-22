import { Context, Effect, Layer, Schema } from "effect"
import { webCrypto } from "@integragents/contracts"
import { IdentityProvider, LoginHandoffHash, SessionTokenHash, SubjectId, TenantId } from "../domain.ts"
import type { AuthSession, ExternalIdentity, Login, LoginHandoff, Subject, Tenant } from "../domain.ts"
import { PasswordHash } from "../passwords.ts"
import { millis, Millis, NullableMillis } from "./columns.ts"
import { now, operation, stored, StoreSql } from "./sql.ts"
import type { GatewayStoreError } from "./sql.ts"

export interface CreateTenantInput {
  readonly id?: TenantId
  readonly name: string
}

export interface CreateSubjectInput {
  readonly id: SubjectId
  readonly tenantId: TenantId
}

export interface LoginRecord extends Login {
  readonly passwordHash: PasswordHash | null
}

export interface IdentityOAuthStateRecord {
  readonly stateHash: LoginHandoffHash
  readonly provider: IdentityProvider
  readonly handoffHash: LoginHandoffHash | null
  readonly returnPath: string | null
  readonly expiresAt: Date
}

/** Tenants, the people in them, and how those people sign in. */
export interface IdentityStore {
  createTenant(input?: CreateTenantInput): Effect.Effect<Tenant, GatewayStoreError>
  listTenants(): Effect.Effect<ReadonlyArray<Tenant>, GatewayStoreError>
  findTenantById(id: TenantId): Effect.Effect<Tenant | undefined, GatewayStoreError>
  findTenantByName(name: string): Effect.Effect<Tenant | undefined, GatewayStoreError>
  deleteTenant(id: TenantId): Effect.Effect<void, GatewayStoreError>

  createSubject(input: CreateSubjectInput): Effect.Effect<Subject, GatewayStoreError>
  listSubjects(tenantId: TenantId): Effect.Effect<ReadonlyArray<Subject>, GatewayStoreError>
  countSubjects(tenantId: TenantId): Effect.Effect<number, GatewayStoreError>
  findSubjectById(id: SubjectId): Effect.Effect<Subject | undefined, GatewayStoreError>
  deleteSubject(subjectId: SubjectId): Effect.Effect<void, GatewayStoreError>

  createLogin(input: {
    readonly subjectId: SubjectId
    readonly tenantId: TenantId
    readonly email: string
    readonly passwordHash: PasswordHash | null
  }): Effect.Effect<LoginRecord, GatewayStoreError>
  findLoginByEmail(email: string): Effect.Effect<LoginRecord | undefined, GatewayStoreError>
  findLoginBySubject(subjectId: SubjectId): Effect.Effect<LoginRecord | undefined, GatewayStoreError>
  countLogins(): Effect.Effect<number, GatewayStoreError>
  changeLoginEmail(subjectId: SubjectId, email: string): Effect.Effect<void, GatewayStoreError>
  changeLoginPassword(subjectId: SubjectId, passwordHash: string): Effect.Effect<void, GatewayStoreError>

  createSession(input: {
    readonly tokenHash: SessionTokenHash
    readonly subjectId: SubjectId
    readonly tenantId: TenantId
    readonly expiresAt: Date
  }): Effect.Effect<AuthSession, GatewayStoreError>
  findLiveSession(tokenHash: SessionTokenHash): Effect.Effect<AuthSession | undefined, GatewayStoreError>
  revokeSession(tokenHash: SessionTokenHash): Effect.Effect<void, GatewayStoreError>
  revokeSubjectSessions(
    subjectId: SubjectId,
    exceptTokenHash?: SessionTokenHash
  ): Effect.Effect<number, GatewayStoreError>
  deleteExpiredSessions(now: Date): Effect.Effect<number, GatewayStoreError>

  createExternalIdentity(input: {
    readonly provider: IdentityProvider
    readonly providerSubject: string
    readonly subjectId: SubjectId
    readonly tenantId: TenantId
    readonly email: string
  }): Effect.Effect<ExternalIdentity, GatewayStoreError>
  findExternalIdentity(
    provider: IdentityProvider,
    providerSubject: string
  ): Effect.Effect<ExternalIdentity | undefined, GatewayStoreError>
  listExternalIdentities(subjectId: SubjectId): Effect.Effect<ReadonlyArray<ExternalIdentity>, GatewayStoreError>

  createLoginHandoff(input: {
    readonly requestHash: LoginHandoffHash
    readonly expiresAt: Date
  }): Effect.Effect<LoginHandoff, GatewayStoreError>
  getLoginHandoff(requestHash: LoginHandoffHash): Effect.Effect<LoginHandoff | undefined, GatewayStoreError>
  completeLoginHandoff(input: {
    readonly requestHash: LoginHandoffHash
    readonly subjectId: SubjectId
    readonly tenantId: TenantId
    readonly email: string
  }): Effect.Effect<boolean, GatewayStoreError>
  collectLoginHandoff(requestHash: LoginHandoffHash): Effect.Effect<boolean, GatewayStoreError>
  createIdentityOAuthState(input: IdentityOAuthStateRecord): Effect.Effect<void, GatewayStoreError>
  consumeIdentityOAuthState(
    stateHash: LoginHandoffHash
  ): Effect.Effect<IdentityOAuthStateRecord | undefined, GatewayStoreError>
  deleteExpiredIdentityFlows(now: Date): Effect.Effect<number, GatewayStoreError>
}

export const TenantRow = Schema.Struct({ id: TenantId, name: Schema.String, createdAt: Millis }).pipe(
  Schema.encodeKeys({ createdAt: "created_at" })
)

const SubjectRow = Schema.Struct({ id: SubjectId, tenantId: TenantId, createdAt: Millis }).pipe(
  Schema.encodeKeys({ tenantId: "tenant_id", createdAt: "created_at" })
)

const LoginRow = Schema.Struct({
  subjectId: SubjectId,
  tenantId: TenantId,
  email: Schema.String,
  passwordHash: Schema.NullOr(PasswordHash),
  createdAt: Millis
}).pipe(
  Schema.encodeKeys({
    subjectId: "subject_id",
    tenantId: "tenant_id",
    passwordHash: "password_hash",
    createdAt: "created_at"
  })
)

const SessionRow = Schema.Struct({
  tokenHash: SessionTokenHash,
  subjectId: SubjectId,
  tenantId: TenantId,
  email: Schema.String,
  createdAt: Millis,
  expiresAt: Millis
}).pipe(
  Schema.encodeKeys({
    tokenHash: "token_hash",
    subjectId: "subject_id",
    tenantId: "tenant_id",
    createdAt: "created_at",
    expiresAt: "expires_at"
  })
)

const ExternalIdentityRow = Schema.Struct({
  provider: IdentityProvider,
  providerSubject: Schema.String,
  subjectId: SubjectId,
  tenantId: TenantId,
  email: Schema.String,
  createdAt: Millis
}).pipe(
  Schema.encodeKeys({
    providerSubject: "provider_subject",
    subjectId: "subject_id",
    tenantId: "tenant_id",
    createdAt: "created_at"
  })
)

const LoginHandoffRow = Schema.Struct({
  requestHash: LoginHandoffHash,
  subjectId: Schema.NullOr(SubjectId),
  tenantId: Schema.NullOr(TenantId),
  email: Schema.NullOr(Schema.String),
  createdAt: Millis,
  expiresAt: Millis,
  collectedAt: NullableMillis
}).pipe(
  Schema.encodeKeys({
    requestHash: "request_hash",
    subjectId: "subject_id",
    tenantId: "tenant_id",
    createdAt: "created_at",
    expiresAt: "expires_at",
    collectedAt: "collected_at"
  })
)

const IdentityOAuthStateRow = Schema.Struct({
  stateHash: LoginHandoffHash,
  provider: IdentityProvider,
  handoffHash: Schema.NullOr(LoginHandoffHash),
  returnPath: Schema.NullOr(Schema.String),
  expiresAt: Millis
}).pipe(
  Schema.encodeKeys({
    stateHash: "state_hash",
    handoffHash: "handoff_hash",
    returnPath: "return_path",
    expiresAt: "expires_at"
  })
)

const sessionQuery = `SELECT gateway_session.*, gateway_login.email
  FROM gateway_session JOIN gateway_login ON gateway_login.subject_id = gateway_session.subject_id
 WHERE gateway_session.token_hash = ?`

export class IdentityStoreService extends Context.Service<IdentityStoreService, IdentityStore>()(
  "@integragents/gateway-core/IdentityStore"
) {
  static readonly layer = Layer.effect(
    IdentityStoreService,
    Effect.map(StoreSql, (db): IdentityStore => ({
      createTenant: (input) =>
        operation(
          "createTenant",
          Effect.gen(function* () {
            const id = input?.id ?? TenantId.make(yield* Effect.orDie(webCrypto.randomUUIDv4))
            yield* db.run("INSERT INTO gateway_tenant (id, name, created_at) VALUES (?, ?, ?)", [
              id,
              input?.name ?? "Untitled",
              yield* now
            ])
            return yield* stored(db.one(TenantRow, "SELECT * FROM gateway_tenant WHERE id = ?", [id]), `tenant ${id}`)
          })
        ),

      listTenants: () =>
        operation("listTenants", db.all(TenantRow, "SELECT * FROM gateway_tenant ORDER BY created_at")),

      findTenantById: (id) =>
        operation("findTenantById", db.one(TenantRow, "SELECT * FROM gateway_tenant WHERE id = ?", [id])),

      findTenantByName: (name) =>
        operation("findTenantByName", db.one(TenantRow, "SELECT * FROM gateway_tenant WHERE name = ?", [name])),

      deleteTenant: (id) => operation("deleteTenant", db.run("DELETE FROM gateway_tenant WHERE id = ?", [id])),

      createSubject: (input) =>
        operation(
          "createSubject",
          Effect.gen(function* () {
            yield* db.run("INSERT INTO gateway_subject (id, tenant_id, created_at) VALUES (?, ?, ?)", [
              input.id,
              input.tenantId,
              yield* now
            ])
            return yield* stored(
              db.one(SubjectRow, "SELECT * FROM gateway_subject WHERE id = ?", [input.id]),
              `subject ${input.id}`
            )
          })
        ),

      listSubjects: (tenantId) =>
        operation(
          "listSubjects",
          db.all(SubjectRow, "SELECT * FROM gateway_subject WHERE tenant_id = ? ORDER BY created_at", [tenantId])
        ),

      countSubjects: (tenantId) =>
        operation(
          "countSubjects",
          db.count("SELECT COUNT(*) AS total FROM gateway_subject WHERE tenant_id = ?", [tenantId])
        ),

      findSubjectById: (id) =>
        operation("findSubjectById", db.one(SubjectRow, "SELECT * FROM gateway_subject WHERE id = ?", [id])),

      deleteSubject: (subjectId) =>
        operation("deleteSubject", db.run("DELETE FROM gateway_subject WHERE id = ?", [subjectId])),

      createLogin: (input) =>
        operation(
          "createLogin",
          Effect.gen(function* () {
            yield* db.run(
              "INSERT INTO gateway_login (subject_id, tenant_id, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)",
              [input.subjectId, input.tenantId, input.email, input.passwordHash, yield* now]
            )
            return yield* stored(
              db.one(LoginRow, "SELECT * FROM gateway_login WHERE subject_id = ?", [input.subjectId]),
              `login for ${input.email}`
            )
          })
        ),

      findLoginByEmail: (email) =>
        operation("findLoginByEmail", db.one(LoginRow, "SELECT * FROM gateway_login WHERE email = ?", [email])),

      findLoginBySubject: (subjectId) =>
        operation(
          "findLoginBySubject",
          db.one(LoginRow, "SELECT * FROM gateway_login WHERE subject_id = ?", [subjectId])
        ),

      countLogins: () => operation("countLogins", db.count("SELECT COUNT(*) AS total FROM gateway_login")),

      changeLoginEmail: (subjectId, email) =>
        operation(
          "changeLoginEmail",
          db.run("UPDATE gateway_login SET email = ? WHERE subject_id = ?", [email, subjectId])
        ),

      changeLoginPassword: (subjectId, passwordHash) =>
        operation(
          "changeLoginPassword",
          db.run("UPDATE gateway_login SET password_hash = ? WHERE subject_id = ?", [passwordHash, subjectId])
        ),

      createSession: (input) =>
        operation(
          "createSession",
          Effect.gen(function* () {
            yield* db.run(
              "INSERT INTO gateway_session (token_hash, subject_id, tenant_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
              [input.tokenHash, input.subjectId, input.tenantId, yield* now, millis(input.expiresAt)]
            )
            return yield* stored(db.one(SessionRow, sessionQuery, [input.tokenHash]), "session")
          })
        ),

      findLiveSession: (tokenHash) =>
        operation(
          "findLiveSession",
          Effect.gen(function* () {
            return yield* db.one(SessionRow, `${sessionQuery} AND gateway_session.expires_at > ?`, [
              tokenHash,
              yield* now
            ])
          })
        ),

      revokeSession: (tokenHash) =>
        operation("revokeSession", db.run("DELETE FROM gateway_session WHERE token_hash = ?", [tokenHash])),

      revokeSubjectSessions: (subjectId, exceptTokenHash) =>
        operation(
          "revokeSubjectSessions",
          exceptTokenHash === undefined
            ? db.changed("DELETE FROM gateway_session WHERE subject_id = ? RETURNING token_hash", [subjectId])
            : db.changed("DELETE FROM gateway_session WHERE subject_id = ? AND token_hash != ? RETURNING token_hash", [
                subjectId,
                exceptTokenHash
              ])
        ),

      deleteExpiredSessions: (at) =>
        operation(
          "deleteExpiredSessions",
          db.changed("DELETE FROM gateway_session WHERE expires_at <= ? RETURNING token_hash", [millis(at)])
        ),

      createExternalIdentity: (input) =>
        operation(
          "createExternalIdentity",
          Effect.gen(function* () {
            yield* db.run(
              `INSERT INTO gateway_external_identity
             (provider, provider_subject, subject_id, tenant_id, email, created_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (provider, provider_subject) DO UPDATE SET email = excluded.email`,
              [input.provider, input.providerSubject, input.subjectId, input.tenantId, input.email, yield* now]
            )
            return yield* stored(
              db.one(
                ExternalIdentityRow,
                "SELECT * FROM gateway_external_identity WHERE provider = ? AND provider_subject = ?",
                [input.provider, input.providerSubject]
              ),
              `${input.provider} identity`
            )
          })
        ),

      findExternalIdentity: (provider, providerSubject) =>
        operation(
          "findExternalIdentity",
          db.one(
            ExternalIdentityRow,
            "SELECT * FROM gateway_external_identity WHERE provider = ? AND provider_subject = ?",
            [provider, providerSubject]
          )
        ),

      listExternalIdentities: (subjectId) =>
        operation(
          "listExternalIdentities",
          db.all(
            ExternalIdentityRow,
            "SELECT * FROM gateway_external_identity WHERE subject_id = ? ORDER BY created_at",
            [subjectId]
          )
        ),

      createLoginHandoff: (input) =>
        operation(
          "createLoginHandoff",
          Effect.gen(function* () {
            yield* db.run(
              `INSERT INTO gateway_login_handoff
             (request_hash, subject_id, tenant_id, email, created_at, expires_at, collected_at)
           VALUES (?, NULL, NULL, NULL, ?, ?, NULL)`,
              [input.requestHash, yield* now, millis(input.expiresAt)]
            )
            return yield* stored(
              db.one(LoginHandoffRow, "SELECT * FROM gateway_login_handoff WHERE request_hash = ?", [
                input.requestHash
              ]),
              "login handoff"
            )
          })
        ),

      getLoginHandoff: (requestHash) =>
        operation(
          "getLoginHandoff",
          db.one(LoginHandoffRow, "SELECT * FROM gateway_login_handoff WHERE request_hash = ?", [requestHash])
        ),

      completeLoginHandoff: (input) =>
        operation(
          "completeLoginHandoff",
          Effect.gen(function* () {
            const changed = yield* db.changed(
              `UPDATE gateway_login_handoff
              SET subject_id = ?, tenant_id = ?, email = ?
            WHERE request_hash = ? AND collected_at IS NULL AND expires_at > ?
            RETURNING request_hash`,
              [input.subjectId, input.tenantId, input.email, input.requestHash, yield* now]
            )
            return changed > 0
          })
        ),

      collectLoginHandoff: (requestHash) =>
        operation(
          "collectLoginHandoff",
          Effect.gen(function* () {
            const at = yield* now
            const changed = yield* db.changed(
              `UPDATE gateway_login_handoff SET collected_at = ?
            WHERE request_hash = ? AND subject_id IS NOT NULL
              AND collected_at IS NULL AND expires_at > ?
            RETURNING request_hash`,
              [at, requestHash, at]
            )
            return changed > 0
          })
        ),

      createIdentityOAuthState: (input) =>
        operation(
          "createIdentityOAuthState",
          db.run(
            `INSERT INTO gateway_identity_oauth_state
           (state_hash, provider, handoff_hash, return_path, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
            [input.stateHash, input.provider, input.handoffHash, input.returnPath, millis(input.expiresAt)]
          )
        ),

      consumeIdentityOAuthState: (stateHash) =>
        operation(
          "consumeIdentityOAuthState",
          Effect.gen(function* () {
            const state = yield* db.one(
              IdentityOAuthStateRow,
              "DELETE FROM gateway_identity_oauth_state WHERE state_hash = ? AND expires_at > ? RETURNING *",
              [stateHash, yield* now]
            )
            if (state === undefined) {
              yield* db.run("DELETE FROM gateway_identity_oauth_state WHERE state_hash = ?", [stateHash])
            }
            return state
          })
        ),

      deleteExpiredIdentityFlows: (at) =>
        operation(
          "deleteExpiredIdentityFlows",
          Effect.gen(function* () {
            const states = yield* db.changed(
              "DELETE FROM gateway_identity_oauth_state WHERE expires_at <= ? RETURNING state_hash",
              [millis(at)]
            )
            const handoffs = yield* db.changed(
              "DELETE FROM gateway_login_handoff WHERE expires_at <= ? RETURNING request_hash",
              [millis(at)]
            )
            return states + handoffs
          })
        )
    }))
  )
}
