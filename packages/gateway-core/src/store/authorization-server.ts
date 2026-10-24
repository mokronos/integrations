import { Context, Effect, Layer, Schema } from "effect"
import {
  OAuthApplicationId,
  OAuthApplicationKind,
  OAuthGrantId,
  ProfileId,
  SubjectId,
  TenantId,
  defaultLocalSubjectId
} from "../domain.ts"
import type { OAuthGrantView, Profile } from "../domain.ts"
import { OAuthSecretHash, OAuthTokenKind } from "../authorization-server.ts"
import type {
  OAuthActor,
  OAuthApplication,
  OAuthAuthorizationCode,
  OAuthAuthorizationRequest,
  OAuthDeviceRequest,
  OAuthGrant,
  OAuthToken
} from "../authorization-server.ts"
import { JsonText, millis, Millis, NullableMillis } from "./columns.ts"
import { requireProfile } from "./profiles.ts"
import { now, operation, stored, StoreSql } from "./sql.ts"
import type { GatewayStoreError } from "./sql.ts"

/** The gateway as an authorization server: the MCP applications people let act as a profile. */
export interface OAuthStore {
  upsertOAuthApplication(input: {
    readonly id: OAuthApplicationId
    readonly kind: "cimd" | "dcr"
    readonly clientIdentifier: string
    readonly name: string
    readonly redirectUris: ReadonlyArray<string>
    readonly metadata: typeof Schema.Json.Type
  }): Effect.Effect<OAuthApplication, GatewayStoreError>
  findOAuthApplication(clientIdentifier: string): Effect.Effect<OAuthApplication | undefined, GatewayStoreError>
  findOAuthApplicationById(id: OAuthApplicationId): Effect.Effect<OAuthApplication | undefined, GatewayStoreError>
  createOAuthAuthorizationRequest(
    input: Omit<OAuthAuthorizationRequest, "createdAt" | "consumedAt">
  ): Effect.Effect<OAuthAuthorizationRequest, GatewayStoreError>
  getOAuthAuthorizationRequest(id: string): Effect.Effect<OAuthAuthorizationRequest | undefined, GatewayStoreError>
  consumeOAuthAuthorizationRequest(id: string): Effect.Effect<OAuthAuthorizationRequest | undefined, GatewayStoreError>
  findOrCreateOAuthGrant(input: {
    readonly id: OAuthGrantId
    readonly applicationId: OAuthApplicationId
    readonly subjectId: SubjectId
    readonly tenantId: TenantId
    readonly profileId: ProfileId
    readonly resource: string
    readonly scope: "mcp"
  }): Effect.Effect<OAuthGrant, GatewayStoreError>
  listOAuthGrants(tenantId: TenantId): Effect.Effect<ReadonlyArray<OAuthGrantView>, GatewayStoreError>
  revokeOAuthGrant(tenantId: TenantId, id: OAuthGrantId): Effect.Effect<boolean, GatewayStoreError>
  createOAuthAuthorizationCode(
    input: Omit<OAuthAuthorizationCode, "createdAt" | "consumedAt">
  ): Effect.Effect<void, GatewayStoreError>
  consumeOAuthAuthorizationCode(
    hash: OAuthSecretHash
  ): Effect.Effect<OAuthAuthorizationCode | undefined, GatewayStoreError>
  createOAuthDeviceRequest(
    input: Omit<OAuthDeviceRequest, "grantId" | "deniedAt" | "createdAt">
  ): Effect.Effect<void, GatewayStoreError>
  /** A request still waiting for a person, by the code they were shown. */
  findPendingOAuthDeviceRequest(userCode: string): Effect.Effect<OAuthDeviceRequest | undefined, GatewayStoreError>
  /** Settles a waiting request: approved under `grantId`, or denied when it is null. */
  decideOAuthDeviceRequest(
    userCode: string,
    grantId: OAuthGrantId | null
  ): Effect.Effect<OAuthDeviceRequest | undefined, GatewayStoreError>
  /** The request the device polls with; one that is settled or expired is removed as it is read. */
  takeOAuthDeviceRequest(hash: OAuthSecretHash): Effect.Effect<OAuthDeviceRequest | undefined, GatewayStoreError>
  createOAuthTokens(
    tokens: ReadonlyArray<Omit<OAuthToken, "createdAt" | "usedAt" | "revokedAt" | "replacedByHash">>
  ): Effect.Effect<void, GatewayStoreError>
  rotateOAuthRefreshToken(input: {
    readonly hash: OAuthSecretHash
    readonly applicationId: OAuthApplicationId
    readonly resource: string
    readonly accessHash: OAuthSecretHash
    readonly refreshHash: OAuthSecretHash
    readonly accessExpiresAt: Date
    readonly refreshExpiresAt: Date
  }): Effect.Effect<OAuthToken | "reused" | undefined, GatewayStoreError>
  resolveOAuthAccessToken(input: { readonly hash: OAuthSecretHash; readonly resource: string }): Effect.Effect<
    | {
        readonly profile: Profile
        readonly actor: OAuthActor
        readonly expiresAt: Date
        readonly scope: "mcp"
      }
    | undefined,
    GatewayStoreError
  >
  deleteExpiredOAuthState(now: Date): Effect.Effect<number, GatewayStoreError>
}

const Scope = Schema.Literal("mcp")

const ApplicationRow = Schema.Struct({
  id: OAuthApplicationId,
  kind: OAuthApplicationKind,
  clientIdentifier: Schema.String,
  name: Schema.String,
  redirectUris: Schema.fromJsonString(Schema.Array(Schema.String)),
  metadata: JsonText,
  createdAt: Millis,
  updatedAt: Millis,
  revokedAt: NullableMillis
}).pipe(
  Schema.encodeKeys({
    clientIdentifier: "client_identifier",
    redirectUris: "redirect_uris_json",
    metadata: "metadata_json",
    createdAt: "created_at",
    updatedAt: "updated_at",
    revokedAt: "revoked_at"
  })
)

const AuthorizationRequestRow = Schema.Struct({
  id: Schema.String,
  applicationId: OAuthApplicationId,
  redirectUri: Schema.String,
  state: Schema.NullOr(Schema.String),
  codeChallenge: Schema.String,
  resource: Schema.String,
  scope: Scope,
  createdAt: Millis,
  expiresAt: Millis,
  consumedAt: NullableMillis
}).pipe(
  Schema.encodeKeys({
    applicationId: "application_id",
    redirectUri: "redirect_uri",
    codeChallenge: "code_challenge",
    createdAt: "created_at",
    expiresAt: "expires_at",
    consumedAt: "consumed_at"
  })
)

const GrantRow = Schema.Struct({
  id: OAuthGrantId,
  applicationId: OAuthApplicationId,
  subjectId: SubjectId,
  tenantId: TenantId,
  profileId: ProfileId,
  resource: Schema.String,
  scope: Scope,
  createdAt: Millis,
  lastUsedAt: NullableMillis,
  revokedAt: NullableMillis
}).pipe(
  Schema.encodeKeys({
    applicationId: "application_id",
    subjectId: "subject_id",
    tenantId: "tenant_id",
    profileId: "profile_id",
    createdAt: "created_at",
    lastUsedAt: "last_used_at",
    revokedAt: "revoked_at"
  })
)

const GrantViewRow = Schema.Struct({
  id: OAuthGrantId,
  applicationId: OAuthApplicationId,
  applicationKind: OAuthApplicationKind,
  applicationName: Schema.String,
  profileId: ProfileId,
  profileName: Schema.String,
  subjectId: SubjectId,
  subjectEmail: Schema.String,
  scope: Scope,
  createdAt: Millis,
  lastUsedAt: NullableMillis,
  revokedAt: NullableMillis
}).pipe(
  Schema.encodeKeys({
    applicationId: "application_id",
    applicationKind: "application_kind",
    applicationName: "application_name",
    profileId: "profile_id",
    profileName: "profile_name",
    subjectId: "subject_id",
    subjectEmail: "subject_email",
    createdAt: "created_at",
    lastUsedAt: "last_used_at",
    revokedAt: "revoked_at"
  })
)

const AuthorizationCodeRow = Schema.Struct({
  hash: OAuthSecretHash,
  grantId: OAuthGrantId,
  applicationId: OAuthApplicationId,
  redirectUri: Schema.String,
  codeChallenge: Schema.String,
  resource: Schema.String,
  scope: Scope,
  createdAt: Millis,
  expiresAt: Millis,
  consumedAt: NullableMillis
}).pipe(
  Schema.encodeKeys({
    grantId: "grant_id",
    applicationId: "application_id",
    redirectUri: "redirect_uri",
    codeChallenge: "code_challenge",
    createdAt: "created_at",
    expiresAt: "expires_at",
    consumedAt: "consumed_at"
  })
)

const DeviceRequestRow = Schema.Struct({
  deviceCodeHash: OAuthSecretHash,
  userCode: Schema.String,
  applicationId: OAuthApplicationId,
  resource: Schema.String,
  scope: Scope,
  grantId: Schema.NullOr(OAuthGrantId),
  deniedAt: NullableMillis,
  createdAt: Millis,
  expiresAt: Millis
}).pipe(
  Schema.encodeKeys({
    deviceCodeHash: "device_code_hash",
    userCode: "user_code",
    applicationId: "application_id",
    grantId: "grant_id",
    deniedAt: "denied_at",
    createdAt: "created_at",
    expiresAt: "expires_at"
  })
)

const tokenFields = {
  hash: OAuthSecretHash,
  kind: OAuthTokenKind,
  familyId: Schema.String,
  grantId: OAuthGrantId,
  applicationId: OAuthApplicationId,
  resource: Schema.String,
  scope: Scope,
  createdAt: Millis,
  expiresAt: Millis,
  usedAt: NullableMillis,
  revokedAt: NullableMillis,
  replacedByHash: Schema.NullOr(OAuthSecretHash)
}

const tokenKeys = {
  familyId: "family_id",
  grantId: "grant_id",
  applicationId: "application_id",
  createdAt: "created_at",
  expiresAt: "expires_at",
  usedAt: "used_at",
  revokedAt: "revoked_at",
  replacedByHash: "replaced_by_hash"
} as const

const TokenRow = Schema.Struct(tokenFields).pipe(Schema.encodeKeys(tokenKeys))

/** An access token with who it acts for, as resolving a call's bearer reads it. */
const AccessTokenRow = Schema.Struct({
  ...tokenFields,
  subjectId: SubjectId,
  profileId: ProfileId,
  applicationName: Schema.String
}).pipe(
  Schema.encodeKeys({
    ...tokenKeys,
    subjectId: "subject_id",
    profileId: "profile_id",
    applicationName: "application_name"
  })
)

const insertToken = `INSERT INTO gateway_oauth_token
  (hash, kind, family_id, grant_id, application_id, resource, scope, created_at, expires_at, used_at, revoked_at, replaced_by_hash)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`

export class OAuthStoreService extends Context.Service<OAuthStoreService, OAuthStore>()(
  "@integragents/gateway-core/OAuthStore"
) {
  static readonly layer = Layer.effect(
    OAuthStoreService,
    Effect.map(StoreSql, (db): OAuthStore => ({
      upsertOAuthApplication: (input) =>
        operation(
          "upsertOAuthApplication",
          Effect.gen(function* () {
            const timestamp = yield* now
            yield* db.run(
              `INSERT INTO gateway_oauth_application
             (id, kind, client_identifier, name, redirect_uris_json, metadata_json, created_at, updated_at, revoked_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
           ON CONFLICT (client_identifier) DO UPDATE SET
             kind = excluded.kind,
             name = excluded.name,
             redirect_uris_json = excluded.redirect_uris_json,
             metadata_json = excluded.metadata_json,
             updated_at = excluded.updated_at,
             revoked_at = NULL`,
              [
                input.id,
                input.kind,
                input.clientIdentifier,
                input.name,
                JSON.stringify(input.redirectUris),
                JSON.stringify(input.metadata),
                timestamp,
                timestamp
              ]
            )
            return yield* stored(
              db.one(ApplicationRow, "SELECT * FROM gateway_oauth_application WHERE client_identifier = ?", [
                input.clientIdentifier
              ]),
              "OAuth application"
            )
          })
        ),

      findOAuthApplication: (clientIdentifier) =>
        operation(
          "findOAuthApplication",
          db.one(
            ApplicationRow,
            "SELECT * FROM gateway_oauth_application WHERE client_identifier = ? AND revoked_at IS NULL",
            [clientIdentifier]
          )
        ),

      findOAuthApplicationById: (id) =>
        operation(
          "findOAuthApplicationById",
          db.one(ApplicationRow, "SELECT * FROM gateway_oauth_application WHERE id = ? AND revoked_at IS NULL", [id])
        ),

      createOAuthAuthorizationRequest: (input) =>
        operation(
          "createOAuthAuthorizationRequest",
          Effect.gen(function* () {
            yield* db.run(
              `INSERT INTO gateway_oauth_authorization_request
             (id, application_id, redirect_uri, state, code_challenge, resource, scope, created_at, expires_at, consumed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
              [
                input.id,
                input.applicationId,
                input.redirectUri,
                input.state,
                input.codeChallenge,
                input.resource,
                input.scope,
                yield* now,
                millis(input.expiresAt)
              ]
            )
            return yield* stored(
              db.one(AuthorizationRequestRow, "SELECT * FROM gateway_oauth_authorization_request WHERE id = ?", [
                input.id
              ]),
              "OAuth authorization request"
            )
          })
        ),

      getOAuthAuthorizationRequest: (id) =>
        operation(
          "getOAuthAuthorizationRequest",
          Effect.gen(function* () {
            return yield* db.one(
              AuthorizationRequestRow,
              "SELECT * FROM gateway_oauth_authorization_request WHERE id = ? AND consumed_at IS NULL AND expires_at > ?",
              [id, yield* now]
            )
          })
        ),

      consumeOAuthAuthorizationRequest: (id) =>
        operation(
          "consumeOAuthAuthorizationRequest",
          Effect.gen(function* () {
            const at = yield* now
            return yield* db.one(
              AuthorizationRequestRow,
              `UPDATE gateway_oauth_authorization_request SET consumed_at = ?
            WHERE id = ? AND consumed_at IS NULL AND expires_at > ? RETURNING *`,
              [at, id, at]
            )
          })
        ),

      findOrCreateOAuthGrant: (input) =>
        operation(
          "findOrCreateOAuthGrant",
          Effect.gen(function* () {
            if (input.subjectId === defaultLocalSubjectId) {
              yield* db.run(
                "INSERT INTO gateway_subject (id, tenant_id, created_at) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING",
                [defaultLocalSubjectId, input.tenantId, yield* now]
              )
            }
            yield* db.run(
              `INSERT INTO gateway_oauth_grant
             (id, application_id, subject_id, tenant_id, profile_id, resource, scope, created_at, last_used_at, revoked_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
           ON CONFLICT (application_id, subject_id, profile_id, resource, scope)
           DO UPDATE SET revoked_at = NULL`,
              [
                input.id,
                input.applicationId,
                input.subjectId,
                input.tenantId,
                input.profileId,
                input.resource,
                input.scope,
                yield* now
              ]
            )
            return yield* stored(
              db.one(
                GrantRow,
                `SELECT * FROM gateway_oauth_grant
              WHERE application_id = ? AND subject_id = ? AND profile_id = ? AND resource = ? AND scope = ?`,
                [input.applicationId, input.subjectId, input.profileId, input.resource, input.scope]
              ),
              "OAuth grant"
            )
          })
        ),

      listOAuthGrants: (tenantId) =>
        operation(
          "listOAuthGrants",
          db.all(
            GrantViewRow,
            `SELECT g.*, a.kind AS application_kind, a.name AS application_name,
                p.name AS profile_name, COALESCE(l.email, 'Local operator') AS subject_email
           FROM gateway_oauth_grant g
           JOIN gateway_oauth_application a ON a.id = g.application_id
           JOIN gateway_profile p ON p.id = g.profile_id
           LEFT JOIN gateway_login l ON l.subject_id = g.subject_id
          WHERE g.tenant_id = ? ORDER BY g.created_at DESC`,
            [tenantId]
          )
        ),

      revokeOAuthGrant: (tenantId, id) =>
        operation(
          "revokeOAuthGrant",
          Effect.gen(function* () {
            const timestamp = yield* now
            return yield* db.sql.withTransaction(
              Effect.gen(function* () {
                const revoked = yield* db.changed(
                  `UPDATE gateway_oauth_grant SET revoked_at = ?
                WHERE tenant_id = ? AND id = ? AND revoked_at IS NULL RETURNING id`,
                  [timestamp, tenantId, id]
                )
                if (revoked > 0) {
                  yield* db.run(
                    "UPDATE gateway_oauth_token SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL",
                    [timestamp, id]
                  )
                }
                return revoked > 0
              })
            )
          })
        ),

      createOAuthAuthorizationCode: (input) =>
        operation(
          "createOAuthAuthorizationCode",
          Effect.gen(function* () {
            yield* db.run(
              `INSERT INTO gateway_oauth_authorization_code
             (hash, grant_id, application_id, redirect_uri, code_challenge, resource, scope, created_at, expires_at, consumed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
              [
                input.hash,
                input.grantId,
                input.applicationId,
                input.redirectUri,
                input.codeChallenge,
                input.resource,
                input.scope,
                yield* now,
                millis(input.expiresAt)
              ]
            )
          })
        ),

      consumeOAuthAuthorizationCode: (hash) =>
        operation(
          "consumeOAuthAuthorizationCode",
          Effect.gen(function* () {
            const code = yield* db.one(
              AuthorizationCodeRow,
              `DELETE FROM gateway_oauth_authorization_code
            WHERE hash = ? AND consumed_at IS NULL AND expires_at > ? RETURNING *`,
              [hash, yield* now]
            )
            if (code === undefined) {
              yield* db.run("DELETE FROM gateway_oauth_authorization_code WHERE hash = ?", [hash])
            }
            return code
          })
        ),

      createOAuthDeviceRequest: (input) =>
        operation(
          "createOAuthDeviceRequest",
          Effect.gen(function* () {
            yield* db.run(
              `INSERT INTO gateway_oauth_device_request
             (device_code_hash, user_code, application_id, resource, scope, grant_id, denied_at, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
              [
                input.deviceCodeHash,
                input.userCode,
                input.applicationId,
                input.resource,
                input.scope,
                yield* now,
                millis(input.expiresAt)
              ]
            )
          })
        ),

      findPendingOAuthDeviceRequest: (userCode) =>
        operation(
          "findPendingOAuthDeviceRequest",
          Effect.gen(function* () {
            return yield* db.one(
              DeviceRequestRow,
              `SELECT * FROM gateway_oauth_device_request
            WHERE user_code = ? AND grant_id IS NULL AND denied_at IS NULL AND expires_at > ?`,
              [userCode, yield* now]
            )
          })
        ),

      decideOAuthDeviceRequest: (userCode, grantId) =>
        operation(
          "decideOAuthDeviceRequest",
          Effect.gen(function* () {
            const at = yield* now
            return yield* db.one(
              DeviceRequestRow,
              `UPDATE gateway_oauth_device_request SET grant_id = ?, denied_at = ?
            WHERE user_code = ? AND grant_id IS NULL AND denied_at IS NULL AND expires_at > ? RETURNING *`,
              [grantId, grantId === null ? at : null, userCode, at]
            )
          })
        ),

      takeOAuthDeviceRequest: (hash) =>
        operation(
          "takeOAuthDeviceRequest",
          db.sql.withTransaction(
            Effect.gen(function* () {
              const request = yield* db.one(
                DeviceRequestRow,
                "SELECT * FROM gateway_oauth_device_request WHERE device_code_hash = ?",
                [hash]
              )
              if (request === undefined) return undefined
              const settled = request.grantId !== null || request.deniedAt !== null
              if (settled || request.expiresAt.getTime() <= (yield* now)) {
                yield* db.run("DELETE FROM gateway_oauth_device_request WHERE device_code_hash = ?", [hash])
              }
              return request
            })
          )
        ),

      createOAuthTokens: (tokens) =>
        operation(
          "createOAuthTokens",
          Effect.gen(function* () {
            const timestamp = yield* now
            yield* db.batch(
              tokens.map((token) => ({
                sql: insertToken,
                args: [
                  token.hash,
                  token.kind,
                  token.familyId,
                  token.grantId,
                  token.applicationId,
                  token.resource,
                  token.scope,
                  timestamp,
                  millis(token.expiresAt)
                ]
              }))
            )
          })
        ),

      rotateOAuthRefreshToken: (input) =>
        operation(
          "rotateOAuthRefreshToken",
          db.sql.withTransaction(
            Effect.gen(function* () {
              const timestamp = yield* now
              const token = yield* db.one(
                TokenRow,
                `SELECT t.* FROM gateway_oauth_token t
               JOIN gateway_oauth_grant g ON g.id = t.grant_id
               JOIN gateway_oauth_application a ON a.id = t.application_id
              WHERE t.hash = ? AND t.kind = 'refresh' AND t.application_id = ? AND t.resource = ? AND t.expires_at > ?
                AND t.revoked_at IS NULL AND g.revoked_at IS NULL AND a.revoked_at IS NULL`,
                [input.hash, input.applicationId, input.resource, timestamp]
              )
              if (token === undefined) return undefined
              if (token.usedAt !== null || token.replacedByHash !== null) {
                yield* db.run(
                  "UPDATE gateway_oauth_token SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL",
                  [timestamp, token.familyId]
                )
                return "reused" as const
              }
              yield* db.run("UPDATE gateway_oauth_token SET used_at = ?, replaced_by_hash = ? WHERE hash = ?", [
                timestamp,
                input.refreshHash,
                input.hash
              ])
              const replacements = [
                { hash: input.accessHash, kind: "access", expiresAt: input.accessExpiresAt },
                {
                  hash: input.refreshHash,
                  kind: "refresh",
                  expiresAt: new Date(Math.min(input.refreshExpiresAt.getTime(), token.expiresAt.getTime()))
                }
              ]
              for (const replacement of replacements) {
                yield* db.run(insertToken, [
                  replacement.hash,
                  replacement.kind,
                  token.familyId,
                  token.grantId,
                  token.applicationId,
                  token.resource,
                  token.scope,
                  timestamp,
                  millis(replacement.expiresAt)
                ])
              }
              return token
            })
          )
        ),

      resolveOAuthAccessToken: (input) =>
        operation(
          "resolveOAuthAccessToken",
          Effect.gen(function* () {
            const timestamp = yield* now
            const token = yield* db.one(
              AccessTokenRow,
              `SELECT t.*, g.subject_id, g.profile_id, a.name AS application_name
             FROM gateway_oauth_token t
             JOIN gateway_oauth_grant g ON g.id = t.grant_id
             JOIN gateway_oauth_application a ON a.id = t.application_id
             JOIN gateway_profile p ON p.id = g.profile_id
            WHERE t.hash = ? AND t.kind = 'access' AND t.resource = ? AND t.expires_at > ?
              AND t.revoked_at IS NULL AND g.revoked_at IS NULL AND a.revoked_at IS NULL
              AND p.revoked_at IS NULL`,
              [input.hash, input.resource, timestamp]
            )
            if (token === undefined) return undefined
            const profile = yield* requireProfile(db, token.profileId)
            yield* db.run("UPDATE gateway_oauth_grant SET last_used_at = ? WHERE id = ?", [timestamp, token.grantId])
            return {
              profile,
              actor: {
                grantId: token.grantId,
                applicationId: token.applicationId,
                applicationName: token.applicationName,
                subjectId: token.subjectId
              },
              expiresAt: token.expiresAt,
              scope: token.scope
            }
          })
        ),

      deleteExpiredOAuthState: (at) =>
        operation(
          "deleteExpiredOAuthState",
          Effect.gen(function* () {
            const expiresAt = millis(at)
            const requests = yield* db.changed(
              "DELETE FROM gateway_oauth_authorization_request WHERE expires_at <= ? RETURNING id",
              [expiresAt]
            )
            const codes = yield* db.changed(
              "DELETE FROM gateway_oauth_authorization_code WHERE expires_at <= ? RETURNING hash",
              [expiresAt]
            )
            const devices = yield* db.changed(
              "DELETE FROM gateway_oauth_device_request WHERE expires_at <= ? RETURNING device_code_hash",
              [expiresAt]
            )
            const tokens = yield* db.changed("DELETE FROM gateway_oauth_token WHERE expires_at <= ? RETURNING hash", [
              expiresAt
            ])
            return requests + codes + devices + tokens
          })
        )
    }))
  )
}
