import { Context, Effect, Layer, Schema, SchemaTransformation } from "effect"
import {
  ApiKeyHash,
  ApiKeyId,
  ApprovalDestinationId,
  ApprovalExpiryMinutes,
  ApprovalGroupWindowMinutes,
  ApprovalMethod,
  McpSurface,
  ProfileCapability,
  ProfileId,
  ProfileSubjects,
  SubjectId,
  TenantId,
  ToolDecision,
  ToolName,
  defaultApprovalExpiryMinutes,
  defaultApprovalGroupWindowMinutes,
  defaultApprovalMethod
} from "../domain.ts"
import type { ApiKey, Profile, ProfileTool, ProfileToolInput } from "../domain.ts"
import { ConnectionColumns, connectionArgs, connectionOf, Millis, NullableMillis } from "./columns.ts"
import { now, operation, stored, StoreSql } from "./sql.ts"
import type { GatewayStoreError, Statement, StoreQueries } from "./sql.ts"

export interface CreateProfileInput {
  readonly tenantId: TenantId
  readonly id: ProfileId
  readonly name: string
  readonly capabilities: ReadonlyArray<ProfileCapability>
  readonly approvalMethod?: ApprovalMethod
  readonly mcpSurface?: McpSurface
  readonly approvalGroupWindowMinutes?: ApprovalGroupWindowMinutes
  readonly includeNewTools?: boolean
  /** A day when absent; null lets calls wait until someone decides. */
  readonly approvalExpiryMinutes?: ApprovalExpiryMinutes | null | undefined
  readonly subjects?: ProfileSubjects
  readonly tools: ReadonlyArray<ProfileToolInput>
  readonly destinationIds?: ReadonlyArray<ApprovalDestinationId>
}

export interface ProfileSettings {
  readonly capabilities: ReadonlyArray<ProfileCapability>
  readonly approvalMethod: ApprovalMethod
  readonly mcpSurface: McpSurface
  readonly approvalGroupWindowMinutes: ApprovalGroupWindowMinutes
  readonly includeNewTools: boolean
  readonly approvalExpiryMinutes: ApprovalExpiryMinutes | null
  readonly subjects: ProfileSubjects
}

export interface GatewayOverviewCounts {
  readonly profiles: number
  readonly profileTools: number
  readonly keys: number
  readonly pendingApprovals: number
}

/** Profiles, the tools each one enables, and the API keys its apps connect with. */
export interface ProfileStore {
  createProfile(input: CreateProfileInput): Effect.Effect<Profile, GatewayStoreError>
  listProfiles(tenantId: TenantId): Effect.Effect<ReadonlyArray<Profile>, GatewayStoreError>
  overviewCounts(tenantId: TenantId): Effect.Effect<GatewayOverviewCounts, GatewayStoreError>
  findProfileById(tenantId: TenantId, id: ProfileId): Effect.Effect<Profile | undefined, GatewayStoreError>
  findProfileByName(tenantId: TenantId, name: string): Effect.Effect<Profile | undefined, GatewayStoreError>
  updateProfileSettings(
    tenantId: TenantId,
    id: ProfileId,
    settings: ProfileSettings
  ): Effect.Effect<Profile, GatewayStoreError>
  renameProfile(tenantId: TenantId, id: ProfileId, name: string): Effect.Effect<Profile, GatewayStoreError>
  revokeProfile(tenantId: TenantId, id: ProfileId): Effect.Effect<void, GatewayStoreError>
  listProfileTools(id: ProfileId): Effect.Effect<ReadonlyArray<ProfileTool>, GatewayStoreError>
  replaceProfileTools(
    id: ProfileId,
    tools: ReadonlyArray<ProfileToolInput>
  ): Effect.Effect<ReadonlyArray<ProfileTool>, GatewayStoreError>

  addApiKey(input: {
    readonly id: ApiKeyId
    readonly profileId: ProfileId
    readonly name: string
    readonly hash: ApiKeyHash
    readonly subjectId?: SubjectId
  }): Effect.Effect<ApiKey, GatewayStoreError>
  listApiKeys(profileId: ProfileId): Effect.Effect<ReadonlyArray<ApiKey>, GatewayStoreError>
  findApiKeyByHash(
    hash: ApiKeyHash
  ): Effect.Effect<{ readonly key: ApiKey; readonly profile: Profile } | undefined, GatewayStoreError>
  touchApiKey(id: ApiKeyId): Effect.Effect<void, GatewayStoreError>
  revokeApiKey(id: ApiKeyId): Effect.Effect<void, GatewayStoreError>
}

const SubjectsColumn = Schema.NullOr(Schema.fromJsonString(Schema.Array(SubjectId))).pipe(
  Schema.decodeTo(
    Schema.toType(ProfileSubjects),
    SchemaTransformation.transform({
      decode: (subjects) => subjects ?? "any",
      encode: (subjects) => (subjects === "any" ? null : subjects)
    })
  )
)

const subjectsColumn = (subjects: ProfileSubjects): string | null =>
  subjects === "any" ? null : JSON.stringify(subjects)

export const ProfileRow = Schema.Struct({
  id: ProfileId,
  tenantId: TenantId,
  name: Schema.String,
  capabilities: Schema.fromJsonString(Schema.Array(ProfileCapability)),
  approvalMethod: ApprovalMethod,
  mcpSurface: McpSurface,
  approvalGroupWindowMinutes: ApprovalGroupWindowMinutes,
  includeNewTools: Schema.BooleanFromBit,
  approvalExpiryMinutes: Schema.NullOr(ApprovalExpiryMinutes),
  subjects: SubjectsColumn,
  createdAt: Millis,
  revokedAt: NullableMillis
}).pipe(
  Schema.encodeKeys({
    tenantId: "tenant_id",
    approvalMethod: "approval_method",
    mcpSurface: "mcp_surface",
    approvalGroupWindowMinutes: "approval_group_window_minutes",
    includeNewTools: "include_new_tools",
    approvalExpiryMinutes: "approval_expiry_minutes",
    createdAt: "created_at",
    revokedAt: "revoked_at"
  })
)

const ProfileToolRow = Schema.Struct({
  profile_id: ProfileId,
  ...ConnectionColumns,
  tool: ToolName,
  decision: ToolDecision
})

const toProfileTool = (row: typeof ProfileToolRow.Type): ProfileTool => ({
  profileId: row.profile_id,
  connection: connectionOf(row),
  tool: row.tool,
  decision: row.decision
})

const ApiKeyRow = Schema.Struct({
  id: ApiKeyId,
  profileId: ProfileId,
  name: Schema.String,
  hash: ApiKeyHash,
  subjectId: Schema.NullOr(SubjectId),
  createdAt: Millis,
  lastUsedAt: NullableMillis,
  revokedAt: NullableMillis
}).pipe(
  Schema.encodeKeys({
    profileId: "profile_id",
    subjectId: "subject_id",
    createdAt: "created_at",
    lastUsedAt: "last_used_at",
    revokedAt: "revoked_at"
  })
)

const OverviewRow = Schema.Struct({
  profiles: Schema.Number,
  profileTools: Schema.Number,
  keys: Schema.Number,
  pendingApprovals: Schema.Number
}).pipe(Schema.encodeKeys({ profileTools: "profile_tools", pendingApprovals: "pending_approvals" }))

/** A profile a row elsewhere points at, which the foreign key promises is there. */
export const requireProfile = (db: StoreQueries, id: ProfileId) =>
  stored(db.one(ProfileRow, "SELECT * FROM gateway_profile WHERE id = ?", [id]), `profile ${id}`)

const profileToolStatements = (id: ProfileId, tools: ReadonlyArray<ProfileToolInput>): ReadonlyArray<Statement> =>
  tools.map((tool) => ({
    sql: `INSERT INTO gateway_profile_tool
            (profile_id, owner, subject, integration, connection_name, tool, decision)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [id, ...connectionArgs(tool.connection), tool.tool, tool.decision]
  }))

export class ProfileStoreService extends Context.Service<ProfileStoreService, ProfileStore>()(
  "@integragents/gateway-core/ProfileStore"
) {
  static readonly layer = Layer.effect(
    ProfileStoreService,
    Effect.gen(function* () {
      const db = yield* StoreSql
      const listProfileTools = (id: ProfileId) =>
        Effect.map(
          db.all(
            ProfileToolRow,
            "SELECT * FROM gateway_profile_tool WHERE profile_id = ? ORDER BY integration, connection_name, tool",
            [id]
          ),
          (rows) => rows.map(toProfileTool)
        )

      return {
        createProfile: (input) =>
          operation(
            "createProfile",
            Effect.gen(function* () {
              yield* db.batch([
                {
                  sql: `INSERT INTO gateway_profile
                      (id, tenant_id, name, capabilities, approval_method, mcp_surface, approval_group_window_minutes,
                       include_new_tools, approval_expiry_minutes, subjects, created_at, revoked_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
                  args: [
                    input.id,
                    input.tenantId,
                    input.name,
                    JSON.stringify(input.capabilities),
                    input.approvalMethod ?? defaultApprovalMethod,
                    input.mcpSurface ?? "tools",
                    input.approvalGroupWindowMinutes ?? defaultApprovalGroupWindowMinutes,
                    input.includeNewTools === true ? 1 : 0,
                    input.approvalExpiryMinutes === undefined
                      ? defaultApprovalExpiryMinutes
                      : input.approvalExpiryMinutes,
                    subjectsColumn(input.subjects ?? "any"),
                    yield* now
                  ]
                },
                ...profileToolStatements(input.id, input.tools),
                ...(input.destinationIds ?? []).map((destinationId) => ({
                  sql: `INSERT INTO gateway_profile_approval_destination (profile_id, destination_id)
                    SELECT ?, id FROM gateway_approval_destination WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL`,
                  args: [input.id, input.tenantId, destinationId]
                }))
              ])
              return yield* requireProfile(db, input.id)
            })
          ),

        listProfiles: (tenantId) =>
          operation(
            "listProfiles",
            db.all(ProfileRow, "SELECT * FROM gateway_profile WHERE tenant_id = ? ORDER BY created_at", [tenantId])
          ),

        overviewCounts: (tenantId) =>
          operation(
            "overviewCounts",
            Effect.gen(function* () {
              return yield* stored(
                db.one(
                  OverviewRow,
                  `SELECT
                 (SELECT COUNT(*) FROM gateway_profile
                   WHERE tenant_id = ? AND revoked_at IS NULL) AS profiles,
                 (SELECT COUNT(*) FROM gateway_profile_tool AS tool
                   JOIN gateway_profile AS profile ON profile.id = tool.profile_id
                   WHERE profile.tenant_id = ? AND profile.revoked_at IS NULL) AS profile_tools,
                 (SELECT COUNT(*) FROM gateway_api_key AS api_key
                   JOIN gateway_profile AS profile ON profile.id = api_key.profile_id
                   WHERE profile.tenant_id = ? AND profile.revoked_at IS NULL
                     AND api_key.revoked_at IS NULL) AS keys,
                 (SELECT COUNT(*) FROM gateway_pending_approval
                   WHERE tenant_id = ? AND status = 'pending' AND expires_at > ?) AS pending_approvals`,
                  [tenantId, tenantId, tenantId, tenantId, yield* now]
                ),
                "overview counts"
              )
            })
          ),

        findProfileById: (tenantId, id) =>
          operation(
            "findProfileById",
            db.one(ProfileRow, "SELECT * FROM gateway_profile WHERE tenant_id = ? AND id = ?", [tenantId, id])
          ),

        findProfileByName: (tenantId, name) =>
          operation(
            "findProfileByName",
            db.one(ProfileRow, "SELECT * FROM gateway_profile WHERE tenant_id = ? AND name = ?", [tenantId, name])
          ),

        updateProfileSettings: (tenantId, id, settings) =>
          operation(
            "updateProfileSettings",
            Effect.gen(function* () {
              yield* db.run(
                `UPDATE gateway_profile
                SET capabilities = ?, approval_method = ?, mcp_surface = ?, approval_group_window_minutes = ?,
                    include_new_tools = ?, approval_expiry_minutes = ?, subjects = ?
              WHERE tenant_id = ? AND id = ? AND revoked_at IS NULL`,
                [
                  JSON.stringify(settings.capabilities),
                  settings.approvalMethod,
                  settings.mcpSurface,
                  settings.approvalGroupWindowMinutes,
                  settings.includeNewTools ? 1 : 0,
                  settings.approvalExpiryMinutes,
                  subjectsColumn(settings.subjects),
                  tenantId,
                  id
                ]
              )
              return yield* requireProfile(db, id)
            })
          ),

        renameProfile: (tenantId, id, name) =>
          operation(
            "renameProfile",
            Effect.gen(function* () {
              yield* db.run(
                "UPDATE gateway_profile SET name = ? WHERE tenant_id = ? AND id = ? AND revoked_at IS NULL",
                [name, tenantId, id]
              )
              return yield* requireProfile(db, id)
            })
          ),

        revokeProfile: (tenantId, id) =>
          operation(
            "revokeProfile",
            Effect.gen(function* () {
              yield* db.run(
                "UPDATE gateway_profile SET revoked_at = ? WHERE tenant_id = ? AND id = ? AND revoked_at IS NULL",
                [yield* now, tenantId, id]
              )
            })
          ),

        listProfileTools: (id) => operation("listProfileTools", listProfileTools(id)),

        replaceProfileTools: (id, tools) =>
          operation(
            "replaceProfileTools",
            Effect.gen(function* () {
              yield* db.batch([
                { sql: "DELETE FROM gateway_profile_tool WHERE profile_id = ?", args: [id] },
                ...profileToolStatements(id, tools)
              ])
              return yield* listProfileTools(id)
            })
          ),

        addApiKey: (input) =>
          operation(
            "addApiKey",
            Effect.gen(function* () {
              yield* db.run(
                `INSERT INTO gateway_api_key (id, profile_id, name, hash, subject_id, created_at, last_used_at, revoked_at)
             VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`,
                [input.id, input.profileId, input.name, input.hash, input.subjectId ?? null, yield* now]
              )
              return yield* stored(
                db.one(ApiKeyRow, "SELECT * FROM gateway_api_key WHERE id = ?", [input.id]),
                `API key ${input.id}`
              )
            })
          ),

        listApiKeys: (profileId) =>
          operation(
            "listApiKeys",
            db.all(ApiKeyRow, "SELECT * FROM gateway_api_key WHERE profile_id = ? ORDER BY created_at", [profileId])
          ),

        findApiKeyByHash: (hash) =>
          operation(
            "findApiKeyByHash",
            Effect.gen(function* () {
              const key = yield* db.one(ApiKeyRow, "SELECT * FROM gateway_api_key WHERE hash = ?", [hash])
              if (key === undefined) return undefined
              return { key, profile: yield* requireProfile(db, key.profileId) }
            })
          ),

        touchApiKey: (id) =>
          operation(
            "touchApiKey",
            Effect.gen(function* () {
              yield* db.run("UPDATE gateway_api_key SET last_used_at = ? WHERE id = ?", [yield* now, id])
            })
          ),

        revokeApiKey: (id) =>
          operation(
            "revokeApiKey",
            Effect.gen(function* () {
              yield* db.run("UPDATE gateway_api_key SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", [
                yield* now,
                id
              ])
            })
          )
      }
    })
  )
}
