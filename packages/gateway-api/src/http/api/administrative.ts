import { AlreadyExists, ApprovalConflict, InvalidInput, NotFound, ProfileRevoked } from "@integragents/contracts"
import { Effect, Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api"
import {
  ApprovalExpiryMinutes,
  ApprovalGroupWindowMinutes,
  ApprovalMethod,
  ApprovalRule,
  ApprovalRuleId,
  ApprovalVerdict,
  ArgumentPattern,
  DecidedApproval,
  ApprovalDestination,
  ApprovalDestinationId,
  ApprovalId,
  AuditOutcome,
  AuditRecord,
  McpSurface,
  ApiKeyId,
  ApiKeyView,
  GatewayEvent,
  Profile,
  ProfileCapability,
  ProfileId,
  ProfileSubjects,
  ProfileTool,
  ProfileToolInput,
  ListedApproval,
  PendingApproval,
  SubjectId,
  TenantId
} from "@integragents/contracts"
import {
  Alias,
  ApprovalStatus,
  BooleanFromString,
  InvocationSucceeded,
  InvocationFailed,
  InvocationInputRequired,
  NonNegativeInt,
  NonNegativeIntFromString,
  PositiveInt,
  PositiveIntFromString
} from "@integragents/contracts"
import { Authority } from "../middleware.ts"
import { RequiredAccess } from "../identity.ts"
import { EffectiveTool, Json } from "./shared.ts"

/** Settings left out keep their current value. */
const ProfileSettingsBody = Schema.Struct({
  capabilities: Schema.Array(ProfileCapability),
  approvalMethod: ApprovalMethod,
  mcpSurface: McpSurface,
  approvalGroupWindowMinutes: ApprovalGroupWindowMinutes,
  includeNewTools: Schema.Boolean,
  /** Null lets calls wait until someone decides. */
  approvalExpiryMinutes: Schema.optional(Schema.NullOr(ApprovalExpiryMinutes)),
  subjects: Schema.optional(ProfileSubjects)
})

/** Starts empty, from the tools given, or as an independent copy of another profile. */
const CreateProfileBody = Schema.Struct({
  name: Schema.String,
  copyFrom: Schema.optional(ProfileId),
  tools: Schema.optional(Schema.Array(ProfileToolInput)),
  capabilities: Schema.optional(Schema.Array(ProfileCapability)),
  approvalMethod: Schema.optional(ApprovalMethod),
  mcpSurface: Schema.optional(McpSurface),
  approvalGroupWindowMinutes: Schema.optional(ApprovalGroupWindowMinutes),
  includeNewTools: Schema.optional(Schema.Boolean),
  approvalExpiryMinutes: Schema.optional(Schema.NullOr(ApprovalExpiryMinutes)),
  subjects: Schema.optional(ProfileSubjects)
})

const CreateApprovalDestinationBody = Schema.Struct({
  name: Schema.String,
  url: Schema.String
})

const ReplaceProfileApprovalDestinationsBody = Schema.Struct({
  destinationIds: Schema.Array(ApprovalDestinationId)
})

const ReplaceProfileToolsBody = Schema.Struct({
  tools: Schema.Array(ProfileToolInput)
})

const ProfileSummary = Schema.Struct({
  profile: Profile,
  tools: Schema.Number,
  approvalTools: Schema.Number,
  keys: Schema.Number,
  applications: Schema.Number
})

const SubjectView = Schema.Struct({ id: SubjectId, tenantId: TenantId, createdAt: Schema.Date })
const CreateSubjectBody = Schema.Struct({ id: Schema.optional(SubjectId) })

const SettledOutcome = Schema.Union([InvocationSucceeded, InvocationFailed, InvocationInputRequired])

const DriftReport = Schema.Struct({
  integration: Schema.String,
  entries: Schema.Array(
    Schema.Struct({
      kind: Schema.Literals(["added", "removed", "changed"]),
      integration: Schema.String,
      connection: Schema.String,
      tool: Schema.String
    })
  ),
  checkedAt: Schema.Date,
  baseline: Schema.Boolean,
  tools: Schema.Number
})

const MaintenanceReport = Schema.Struct({
  expiredApprovals: Schema.Number,
  interruptedApprovals: Schema.Number,
  interruptedInvocations: Schema.Number,
  expiredInvocationKeys: Schema.Number,
  expiredAuditArguments: Schema.Number,
  deletedSessions: Schema.Number,
  expiredIdentityFlows: Schema.Number,
  expiredOAuthState: Schema.Number,
  expiredBlobs: Schema.Number,
  expiredAppSessions: Schema.Number
})

export const AdministrativeGroup = HttpApiGroup.make("administrative")
  .add(
    HttpApiEndpoint.get("overview", "/v1/overview", {
      success: Schema.Struct({
        profiles: Schema.Number,
        profileTools: Schema.Number,
        keys: Schema.Number,
        pendingApprovals: Schema.Number,
        connections: Schema.Number,
        recentActivity: Schema.Array(AuditRecord)
      })
    }).annotate(RequiredAccess, "administrative")
  )
  .add(
    HttpApiEndpoint.get("listSubjects", "/v1/subjects", {
      success: Schema.Struct({ subjects: Schema.Array(SubjectView) })
    }).annotate(RequiredAccess, "administrative")
  )
  .add(
    HttpApiEndpoint.post("createSubject", "/v1/subjects", {
      payload: CreateSubjectBody,
      success: HttpApiSchema.status(201)(SubjectView),
      error: AlreadyExists
    }).annotate(RequiredAccess, "administrative")
  )
  .add(
    HttpApiEndpoint.get("listProfiles", "/v1/profiles", {
      success: Schema.Struct({
        profiles: Schema.Array(ProfileSummary),
        gatewayUrl: Schema.optional(Schema.NullOr(Schema.String)),
        mcpUrl: Schema.optional(Schema.NullOr(Schema.String))
      })
    }).annotate(RequiredAccess, "administrative")
  )
  .add(
    HttpApiEndpoint.post("createProfile", "/v1/profiles", {
      payload: CreateProfileBody,
      success: HttpApiSchema.status(201)(Profile),
      error: [NotFound, InvalidInput, AlreadyExists, ProfileRevoked]
    }).annotate(RequiredAccess, "administrative")
  )
  .add(
    HttpApiEndpoint.post("renameProfile", "/v1/profiles/:id/name", {
      params: { id: ProfileId },
      payload: Schema.Struct({ name: Schema.String }),
      success: Profile,
      error: [NotFound, InvalidInput, AlreadyExists, ProfileRevoked]
    }).annotate(RequiredAccess, "administrative")
  )
  .add(
    HttpApiEndpoint.post("updateProfileSettings", "/v1/profiles/:id/settings", {
      params: { id: ProfileId },
      payload: ProfileSettingsBody,
      success: Profile,
      error: [NotFound, InvalidInput, AlreadyExists, ProfileRevoked]
    }).annotate(RequiredAccess, "administrative")
  )
  .add(
    HttpApiEndpoint.get("profileTools", "/v1/profiles/:id/tools", {
      params: { id: ProfileId },
      query: {
        schemas: BooleanFromString.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(false)))
      },
      success: Schema.Struct({ tools: Schema.Array(EffectiveTool) }),
      error: NotFound
    }).annotate(RequiredAccess, "administrative")
  )
  .add(
    HttpApiEndpoint.post("replaceProfileTools", "/v1/profiles/:id/tools", {
      params: { id: ProfileId },
      payload: ReplaceProfileToolsBody,
      success: Schema.Struct({ tools: Schema.Array(ProfileTool) }),
      error: [NotFound, InvalidInput, AlreadyExists, ProfileRevoked]
    }).annotate(RequiredAccess, "administrative")
  )
  .add(
    HttpApiEndpoint.get("listApprovalRules", "/v1/profiles/:id/approval-rules", {
      params: { id: ProfileId },
      success: Schema.Struct({ rules: Schema.Array(ApprovalRule) }),
      error: NotFound
    }).annotate(RequiredAccess, "administrative")
  )
  .add(
    HttpApiEndpoint.post("updateApprovalRule", "/v1/approval-rules/:id", {
      params: { id: ApprovalRuleId },
      payload: ArgumentPattern,
      success: ApprovalRule,
      error: [NotFound, InvalidInput]
    }).annotate(RequiredAccess, "administrative")
  )
  .add(
    HttpApiEndpoint.delete("deleteApprovalRule", "/v1/approval-rules/:id", {
      params: { id: ApprovalRuleId },
      success: Schema.Struct({ deleted: Schema.Literal(true) }),
      error: NotFound
    }).annotate(RequiredAccess, "administrative")
  )
  .add(
    HttpApiEndpoint.get("listApprovalDestinations", "/v1/approval-destinations", {
      success: Schema.Struct({ destinations: Schema.Array(ApprovalDestination) })
    }).annotate(RequiredAccess, "administrative")
  )
  .add(
    HttpApiEndpoint.post("createApprovalDestination", "/v1/approval-destinations", {
      payload: CreateApprovalDestinationBody,
      success: HttpApiSchema.status(201)(
        Schema.Struct({ destination: ApprovalDestination, signingSecret: Schema.String })
      ),
      error: InvalidInput
    }).annotate(RequiredAccess, "administrative")
  )
  .add(
    HttpApiEndpoint.delete("deleteApprovalDestination", "/v1/approval-destinations/:id", {
      params: { id: ApprovalDestinationId },
      success: Schema.Struct({ deleted: Schema.Literal(true) })
    }).annotate(RequiredAccess, "administrative")
  )
  .add(
    HttpApiEndpoint.get("getProfileApprovalDestinations", "/v1/profiles/:id/approval-destinations", {
      params: { id: ProfileId },
      success: Schema.Struct({ destinationIds: Schema.Array(ApprovalDestinationId) }),
      error: NotFound
    }).annotate(RequiredAccess, "administrative")
  )
  .add(
    HttpApiEndpoint.post("replaceProfileApprovalDestinations", "/v1/profiles/:id/approval-destinations", {
      params: { id: ProfileId },
      payload: ReplaceProfileApprovalDestinationsBody,
      success: Schema.Struct({ destinationIds: Schema.Array(ApprovalDestinationId) }),
      error: [NotFound, InvalidInput, AlreadyExists, ProfileRevoked]
    }).annotate(RequiredAccess, "administrative")
  )
  .add(
    HttpApiEndpoint.post("issueKey", "/v1/profiles/:id/keys", {
      params: { id: ProfileId },
      payload: Schema.Struct({
        name: Schema.String,
        /** The one person every call with the key acts for. Without one, the key reaches no delegated tool. */
        subject: Schema.optional(SubjectId)
      }),
      success: HttpApiSchema.status(201)(
        Schema.Struct({
          id: ApiKeyId,
          profileId: ProfileId,
          name: Schema.String,
          subject: Schema.NullOr(SubjectId),
          secret: Schema.String
        })
      ),
      error: [NotFound, InvalidInput, AlreadyExists, ProfileRevoked]
    }).annotate(RequiredAccess, "administrative")
  )
  .add(
    HttpApiEndpoint.get("listKeys", "/v1/profiles/:id/keys", {
      params: { id: ProfileId },
      success: Schema.Struct({ keys: Schema.Array(ApiKeyView) }),
      error: NotFound
    }).annotate(RequiredAccess, "administrative")
  )
  .add(
    HttpApiEndpoint.post("revokeKey", "/v1/keys/:id/revoke", {
      params: { id: ApiKeyId },
      success: Schema.Struct({ revoked: Schema.Literal(true), key: ApiKeyId })
    }).annotate(RequiredAccess, "administrative")
  )
  .add(
    HttpApiEndpoint.post("revokeProfile", "/v1/profiles/:id/revoke", {
      params: { id: ProfileId },
      success: Schema.Struct({
        revoked: Schema.Literal(true),
        cancelledApprovals: Schema.Number
      }),
      error: NotFound
    }).annotate(RequiredAccess, "administrative")
  )
  .add(
    HttpApiEndpoint.get("events", "/v1/events", {
      success: HttpApiSchema.StreamSse({ data: GatewayEvent })
    }).annotate(RequiredAccess, "administrative")
  )
  .add(
    HttpApiEndpoint.get("listApprovals", "/v1/approvals", {
      query: { status: Schema.optional(ApprovalStatus) },
      success: Schema.Struct({ approvals: Schema.Array(ListedApproval) })
    }).annotate(RequiredAccess, "administrative")
  )
  .add(
    HttpApiEndpoint.post("approve", "/v1/approvals/:id/approve", {
      params: { id: ApprovalId },
      /** `arguments` runs instead of the frozen ones, once they pass the tool's input schema. */
      payload: Schema.Struct({ arguments: Schema.optional(Json) }),
      success: Schema.Struct({
        approval: PendingApproval,
        outcome: SettledOutcome
      }),
      error: [NotFound, ApprovalConflict, InvalidInput]
    }).annotate(RequiredAccess, "human")
  )
  .add(
    HttpApiEndpoint.post("decideApprovals", "/v1/approvals/decide", {
      payload: Schema.Struct({
        verdict: ApprovalVerdict,
        ids: Schema.NonEmptyArray(ApprovalId).check(Schema.isMaxLength(500)),
        /** Also approve every later call to this tool that fits the pattern these calls share. */
        remember: Schema.optional(Schema.Boolean)
      }),
      success: Schema.Struct({ results: Schema.Array(DecidedApproval), rule: Schema.optional(ApprovalRule) }),
      error: ApprovalConflict
    }).annotate(RequiredAccess, "human")
  )
  .add(
    HttpApiEndpoint.post("deny", "/v1/approvals/:id/deny", {
      params: { id: ApprovalId },
      success: Schema.Struct({ approval: PendingApproval }),
      error: [NotFound, ApprovalConflict]
    }).annotate(RequiredAccess, "human")
  )
  .add(
    HttpApiEndpoint.post("refreshDrift", "/v1/drift/refresh", {
      query: { integration: Schema.optional(Schema.String) },
      success: Schema.Struct({ reports: Schema.Array(DriftReport) }),
      error: NotFound
    }).annotate(RequiredAccess, "administrative")
  )
  .add(
    HttpApiEndpoint.post("maintenance", "/v1/maintenance", {
      success: MaintenanceReport
    }).annotate(RequiredAccess, "administrative")
  )
  .add(
    HttpApiEndpoint.get("audit", "/v1/audit", {
      query: {
        since: Schema.optional(Schema.DateFromString),
        outcome: Schema.optional(AuditOutcome),
        profileId: Schema.optional(ProfileId),
        alias: Schema.optional(Alias),
        tool: Schema.optional(Schema.String),
        limit: PositiveIntFromString.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(PositiveInt.make(50)))),
        offset: NonNegativeIntFromString.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(NonNegativeInt.make(0))))
      },
      success: Schema.Struct({
        records: Schema.Array(AuditRecord),
        total: Schema.Number,
        limit: PositiveInt,
        offset: NonNegativeInt
      })
    }).annotate(RequiredAccess, "administrative")
  )
  .middleware(Authority)
