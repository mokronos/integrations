import { Effect, Schema } from "effect"
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema
} from "effect/http-api"
import {
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
  BlobId,
  BlobUpload,
  AuditRecord,
  McpSurface,
  ApiKeyId,
  ApiKeyView,
  ConnectionRef,
  GatewayEvent,
  Profile,
  ProfileCapability,
  ProfileId,
  ProfileTool,
  ProfileToolInput,
  ToolDecision,
  ListedApproval,
  PendingApproval,
  SubjectId,
  TenantId,
  OAuthClientSubmission,
  OAuthConsentDecision,
  OAuthConsentView,
  OAuthGrantId,
  OAuthGrantView,
  OAuthSessionView
} from "@integragents/contracts"
import {
  Alias,
  ApprovalStatus,
  BooleanFromString,
  Connection,
  ConnectionName,
  GatewayMetadata,
  Integration,
  IntegrationDiscovery,
  IntegrationSearchKind,
  IntegrationSearchResponse,
  IntegrationValidationReport,
  IntegrationOverview,
  IntegrationSlug,
  InvocationSucceeded,
  InvocationPending,
  InvocationDenied,
  InvocationFailed,
  InvocationInvalid,
  InvocationAuthorizationRequired,
  NonNegativeInt,
  NonNegativeIntFromString,
  PositiveInt,
  PositiveIntFromString,
  Tool,
  ToolSummary
} from "@integragents/contracts"
import { Authority } from "./middleware.ts"
import { Forbidden, ForbiddenError, GatewayFailure, RequiredAccess, Unmetered } from "./identity.ts"

const Json = Schema.Json

const WireAlias = Alias

const ExecuteBody = Schema.Struct({
  alias: WireAlias,
  tool: Schema.String,
  arguments: Schema.optional(Json),
  /** Who the agent acts for. Required by delegated tools, ignored by the rest. */
  subject: Schema.optional(SubjectId)
})

const ProfileSettingsBody = Schema.Struct({
  capabilities: Schema.Array(ProfileCapability),
  approvalMethod: ApprovalMethod,
  mcpSurface: McpSurface,
  approvalGroupWindowMinutes: ApprovalGroupWindowMinutes,
  includeNewTools: Schema.Boolean
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
  includeNewTools: Schema.optional(Schema.Boolean)
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

const DiscoverBody = Schema.Struct({
  url: Schema.String,
  connection: Schema.optional(Schema.String),
  slug: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String)
})

const RenameIntegrationBody = Schema.Struct({ name: Schema.String })

const ConnectBody = Schema.Struct({
  integration: Schema.String,
  connection: Schema.optional(Schema.String),
  template: Schema.optional(Schema.String),
  values: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  /** Connect on behalf of one person rather than the organisation. */
  subject: Schema.optional(SubjectId)
})

const OAuthStartBody = Schema.Struct({
  integration: Schema.String,
  connection: Schema.optional(Schema.String),
  template: Schema.optional(Schema.String),
  subject: Schema.optional(SubjectId),
  clientId: Schema.optional(Schema.String),
  clientSecret: Schema.optional(Schema.String),
  timeoutSeconds: Schema.optional(Schema.Number)
})

const ValidateBody = Schema.Struct({
  node: Json,
  live: Schema.optional(Schema.Boolean)
})

const Email = Schema.String.check(
  Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)
)

export const SignupBody = Schema.Struct({
  email: Email,
  password: Schema.String.check(Schema.isMinLength(8)),
  tenantName: Schema.optional(Schema.String)
})

export const LoginBody = Schema.Struct({
  email: Email,
  password: Schema.String
})

export const ChangeEmailBody = Schema.Struct({
  email: Email,
  password: Schema.String
})

export const ChangePasswordBody = Schema.Struct({
  currentPassword: Schema.optional(Schema.String),
  newPassword: Schema.String.check(Schema.isMinLength(8))
})

export const DeleteAccountBody = Schema.Struct({
  password: Schema.optional(Schema.String)
})

const EffectiveTool = Schema.Struct({
  alias: Alias,
  tool: Schema.String,
  connection: ConnectionRef,
  decision: ToolDecision,
  delegated: Schema.Boolean,
  description: Schema.optional(Schema.String),
  inputSchema: Schema.optional(Json),
  outputSchema: Schema.optional(Json)
})

const InvokedOk = Schema.Union([InvocationSucceeded, InvocationPending, InvocationAuthorizationRequired])

const SubjectView = Schema.Struct({ id: SubjectId, tenantId: TenantId, createdAt: Schema.Date })
const CreateSubjectBody = Schema.Struct({ id: Schema.optional(SubjectId) })
const InvokedDenied = InvocationDenied.pipe(HttpApiSchema.status(403))
const InvokedFailed = InvocationFailed.pipe(HttpApiSchema.status(502))
const InvokedInvalid = InvocationInvalid.pipe(HttpApiSchema.status(400))

const SettledOutcome = Schema.Union([InvocationSucceeded, InvocationFailed])

const ValidationFinding = Schema.Struct({
  severity: Schema.String,
  check: Schema.String,
  message: Schema.String
})
const ValidationReport = Schema.Struct({
  ok: Schema.Boolean,
  findings: Schema.Array(ValidationFinding)
})

const DriftReport = Schema.Struct({
  integration: Schema.String,
  entries: Schema.Array(Schema.Struct({
    kind: Schema.Literals(["added", "removed", "changed"]),
    integration: Schema.String,
    connection: Schema.String,
    tool: Schema.String
  })),
  checkedAt: Schema.Date,
  baseline: Schema.Boolean,
  tools: Schema.Number
})

const MaintenanceReport = Schema.Struct({
  expiredApprovals: Schema.Number,
  expiredAuditArguments: Schema.Number,
  deletedSessions: Schema.Number,
  expiredIdentityFlows: Schema.Number,
  expiredOAuthState: Schema.Number,
  expiredBlobs: Schema.Number
})

class ApiBadRequest extends Schema.TaggedError<ApiBadRequest>()(
  "ApiBadRequest",
  { error: Schema.String }
) {}
const ApiBadRequestError = ApiBadRequest.pipe(HttpApiSchema.status(400))

class ApiNotFound extends Schema.TaggedError<ApiNotFound>()(
  "ApiNotFound",
  { error: Schema.String }
) {}
const ApiNotFoundError = ApiNotFound.pipe(HttpApiSchema.status(404))

class ApiGone extends Schema.TaggedError<ApiGone>()(
  "ApiGone",
  { error: Schema.String }
) {}
const ApiGoneError = ApiGone.pipe(HttpApiSchema.status(410))

class ApiNotImplemented extends Schema.TaggedError<ApiNotImplemented>()(
  "ApiNotImplemented",
  { error: Schema.String, code: Schema.String }
) {}
const ApiNotImplementedError = ApiNotImplemented.pipe(HttpApiSchema.status(501))

class SignupClosed extends Schema.TaggedError<SignupClosed>()(
  "SignupClosed",
  { error: Schema.String, code: Schema.Literal("signup-closed") }
) {}
const SignupClosedError = SignupClosed.pipe(HttpApiSchema.status(403))

class InvalidCredentials extends Schema.TaggedError<InvalidCredentials>()(
  "InvalidCredentials",
  { error: Schema.String, code: Schema.Literal("invalid-credentials") }
) {}
const InvalidCredentialsError = InvalidCredentials.pipe(HttpApiSchema.status(401))

class PasswordRequired extends Schema.TaggedError<PasswordRequired>()(
  "PasswordRequired",
  { error: Schema.String, code: Schema.Literal("password-required") }
) {}
const PasswordRequiredError = PasswordRequired.pipe(HttpApiSchema.status(409))

class HandoffUnknown extends Schema.TaggedError<HandoffUnknown>()(
  "HandoffUnknown",
  { error: Schema.String, code: Schema.Literal("login-handoff-unknown") }
) {}
const HandoffUnknownError = HandoffUnknown.pipe(HttpApiSchema.status(404))

class HandoffExpired extends Schema.TaggedError<HandoffExpired>()(
  "HandoffExpired",
  { error: Schema.String, code: Schema.Literal("login-handoff-expired") }
) {}
const HandoffExpiredError = HandoffExpired.pipe(HttpApiSchema.status(410))

class HandoffCollected extends Schema.TaggedError<HandoffCollected>()(
  "HandoffCollected",
  { error: Schema.String, code: Schema.Literal("login-handoff-collected") }
) {}
const HandoffCollectedError = HandoffCollected.pipe(HttpApiSchema.status(410))

const HandoffRaceError = HandoffCollected.pipe(HttpApiSchema.status(409))

const SystemGroup = HttpApiGroup.make("system")
  .add(HttpApiEndpoint.get("health", "/v1/health", {
    success: Schema.Struct({ ok: Schema.Literal(true) })
  }).annotate(Unmetered, true).annotate(RequiredAccess, "public"))
  .add(HttpApiEndpoint.get("metadata", "/v1/metadata", {
    success: GatewayMetadata
  }).annotate(Unmetered, true).annotate(RequiredAccess, "public"))
  .middleware(Authority)

const FallbackGroup = HttpApiGroup.make("fallback")
  .add(HttpApiEndpoint.make("GET")("unmatchedGet", "/*", {
    success: Schema.Never.pipe(HttpApiSchema.status(404))
  }).annotate(Unmetered, true).annotate(RequiredAccess, "public"))
  .add(HttpApiEndpoint.make("POST")("unmatchedPost", "/*", {
    success: Schema.Never.pipe(HttpApiSchema.status(404))
  }).annotate(Unmetered, true).annotate(RequiredAccess, "public"))
  .add(HttpApiEndpoint.make("DELETE")("unmatchedDelete", "/*", {
    success: Schema.Never.pipe(HttpApiSchema.status(404))
  }).annotate(Unmetered, true).annotate(RequiredAccess, "public"))
  .middleware(Authority)

const DelegatedGroup = HttpApiGroup.make("delegated")
  .add(HttpApiEndpoint.get("listTools", "/v1/tools", {
    query: {
      schemas: BooleanFromString.pipe(
        Schema.withDecodingDefaultTypeKey(Effect.succeed(false))
      ),
      integration: Schema.optional(IntegrationSlug),
      connection: Schema.optional(ConnectionName)
    },
    success: Schema.Struct({ tools: Schema.Array(EffectiveTool) })
  }).annotate(RequiredAccess, "delegated"))
  .add(HttpApiEndpoint.post("execute", "/v1/execute", {
    payload: ExecuteBody,
    success: [InvokedOk, InvokedDenied, InvokedFailed, InvokedInvalid]
  }).annotate(RequiredAccess, "delegated"))
  .add(HttpApiEndpoint.get("approval", "/v1/approvals/:id", {
    params: { id: ApprovalId },
    success: PendingApproval,
    error: ApiNotFoundError
  }).annotate(RequiredAccess, "delegated"))
  .add(HttpApiEndpoint.get("blob", "/v1/blobs/:id", {
    params: { id: BlobId },
    success: HttpApiSchema.StreamUint8Array(),
    error: ApiNotFoundError
  }).annotate(RequiredAccess, "delegated"))
  .add(HttpApiEndpoint.post("uploadBlob", "/v1/blobs", {
    headers: {
      "x-blob-content-type": Schema.optional(Schema.String),
      "x-blob-filename": Schema.optional(Schema.String)
    },
    payload: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()),
    success: BlobUpload
  }).annotate(RequiredAccess, "delegated"))
  .middleware(Authority)

const ProvisioningGroup = HttpApiGroup.make("provisioning")
  .add(HttpApiEndpoint.get("listIntegrations", "/v1/integrations", {
    success: Schema.Struct({
      integrations: Schema.Array(IntegrationOverview),
      oauthCallbackUrl: Schema.optional(Schema.NullOr(Schema.String))
    })
  }).annotate(RequiredAccess, "provisioning"))
  .add(HttpApiEndpoint.post("discover", "/v1/integrations/discover", {
    payload: DiscoverBody,
    success: HttpApiSchema.status(201)(IntegrationDiscovery),
    error: ApiBadRequestError
  }).annotate(RequiredAccess, "provisioning"))
  .add(HttpApiEndpoint.get("integrationTools", "/v1/integrations/:slug/tools", {
    params: { slug: Schema.String },
    success: Schema.Struct({ tools: Schema.Array(ToolSummary) }),
    error: ApiNotFoundError
  }).annotate(RequiredAccess, "provisioning"))
  .add(HttpApiEndpoint.get("describeTool", "/v1/integrations/:slug/tools/:tool", {
    params: { slug: Schema.String, tool: Schema.String },
    query: { connection: Schema.optional(Schema.String) },
    success: Tool,
    error: [ApiNotFoundError, ApiBadRequestError]
  }).annotate(RequiredAccess, "provisioning"))
  .add(HttpApiEndpoint.get("registrySearch", "/v1/registry/search", {
    query: {
      q: Schema.String,
      limit: PositiveIntFromString.pipe(
        Schema.withDecodingDefaultTypeKey(Effect.succeed(PositiveInt.make(5)))
      ),
      kind: Schema.optional(IntegrationSearchKind)
    },
    success: IntegrationSearchResponse,
    error: ApiBadRequestError
  }).annotate(RequiredAccess, "provisioning"))
  .add(HttpApiEndpoint.post("validate", "/v1/validate", {
    payload: ValidateBody,
    success: Schema.Union([ValidationReport, IntegrationValidationReport])
  }).annotate(RequiredAccess, "provisioning"))
  .add(HttpApiEndpoint.get("listConnections", "/v1/connections", {
    success: Schema.Struct({ connections: Schema.Array(Connection) })
  }).annotate(RequiredAccess, "provisioning"))
  .add(HttpApiEndpoint.post("connect", "/v1/connections", {
    payload: ConnectBody,
    success: HttpApiSchema.status(201)(Schema.Struct({
      connection: Connection,
      tools: Schema.Array(ToolSummary)
    })),
    error: [ApiNotFoundError, ApiBadRequestError]
  }).annotate(RequiredAccess, "provisioning"))
  .add(HttpApiEndpoint.post("startOAuth", "/v1/connections/oauth", {
    payload: OAuthStartBody,
    success: HttpApiSchema.status(201)(OAuthSessionView),
    error: [ApiNotFoundError, ApiBadRequestError]
  }).annotate(RequiredAccess, "provisioning"))
  .add(HttpApiEndpoint.get("oauthSession", "/v1/connections/oauth/:id", {
    params: { id: Schema.String },
    success: OAuthSessionView,
    error: ApiNotFoundError
  }).annotate(RequiredAccess, "provisioning"))
  .add(HttpApiEndpoint.post("provideOAuthClient", "/v1/connections/oauth/:id/client", {
    params: { id: Schema.String },
    payload: OAuthClientSubmission,
    success: OAuthSessionView,
    error: [ApiNotFoundError, ApiBadRequestError]
  }).annotate(RequiredAccess, "provisioning"))
  .add(HttpApiEndpoint.get("oauthCallback", "/v1/oauth/callback", {
    query: {
      state: Schema.optional(Schema.String),
      code: Schema.optional(Schema.String),
      error_description: Schema.optional(Schema.String),
      error: Schema.optional(Schema.String),
      domain: Schema.optional(Schema.String),
      site: Schema.optional(Schema.String)
    },
    success: Schema.Struct({ rendered: Schema.Literal(true) })
  }).annotate(RequiredAccess, "public"))
  .add(HttpApiEndpoint.post("renameIntegration", "/v1/integrations/:slug/name", {
    params: { slug: Schema.String },
    payload: RenameIntegrationBody,
    success: Integration,
    error: ApiNotFoundError
  }).annotate(RequiredAccess, "administrative"))
  .add(HttpApiEndpoint.delete("removeIntegration", "/v1/integrations/:slug", {
    params: { slug: Schema.String },
    success: Schema.Struct({
      removed: Schema.Literal(true),
      integration: Schema.String,
      connections: Schema.Array(Schema.String)
    }),
    error: ApiNotFoundError
  }).annotate(RequiredAccess, "provisioning"))
  .add(HttpApiEndpoint.delete("removeConnection", "/v1/connections/:integration/:name", {
    params: { integration: Schema.String, name: Schema.String },
    success: Schema.Struct({
      removed: Schema.Literal(true),
      integration: Schema.String,
      connection: Schema.String
    }),
    error: ApiNotFoundError
  }).annotate(RequiredAccess, "provisioning"))
  .middleware(Authority)

const AdministrativeGroup = HttpApiGroup.make("administrative")
  .add(HttpApiEndpoint.get("overview", "/v1/overview", {
    success: Schema.Struct({
      profiles: Schema.Number,
      profileTools: Schema.Number,
      keys: Schema.Number,
      pendingApprovals: Schema.Number,
      connections: Schema.Number,
      recentActivity: Schema.Array(AuditRecord)
    })
  }).annotate(RequiredAccess, "administrative"))
  .add(HttpApiEndpoint.get("listSubjects", "/v1/subjects", {
    success: Schema.Struct({ subjects: Schema.Array(SubjectView) })
  }).annotate(RequiredAccess, "administrative"))
  .add(HttpApiEndpoint.post("createSubject", "/v1/subjects", {
    payload: CreateSubjectBody,
    success: HttpApiSchema.status(201)(SubjectView),
    error: ApiBadRequestError
  }).annotate(RequiredAccess, "administrative"))
  .add(HttpApiEndpoint.get("listProfiles", "/v1/profiles", {
    success: Schema.Struct({
      profiles: Schema.Array(ProfileSummary),
      gatewayUrl: Schema.optional(Schema.NullOr(Schema.String)),
      mcpUrl: Schema.optional(Schema.NullOr(Schema.String))
    })
  }).annotate(RequiredAccess, "administrative"))
  .add(HttpApiEndpoint.post("createProfile", "/v1/profiles", {
    payload: CreateProfileBody,
    success: HttpApiSchema.status(201)(Profile),
    error: [ApiNotFoundError, ApiBadRequestError]
  }).annotate(RequiredAccess, "administrative"))
  .add(HttpApiEndpoint.post("renameProfile", "/v1/profiles/:id/name", {
    params: { id: ProfileId },
    payload: Schema.Struct({ name: Schema.String }),
    success: Profile,
    error: [ApiNotFoundError, ApiBadRequestError]
  }).annotate(RequiredAccess, "administrative"))
  .add(HttpApiEndpoint.post("updateProfileSettings", "/v1/profiles/:id/settings", {
    params: { id: ProfileId },
    payload: ProfileSettingsBody,
    success: Profile,
    error: [ApiNotFoundError, ApiBadRequestError]
  }).annotate(RequiredAccess, "administrative"))
  .add(HttpApiEndpoint.get("profileTools", "/v1/profiles/:id/tools", {
    params: { id: ProfileId },
    query: {
      schemas: BooleanFromString.pipe(
        Schema.withDecodingDefaultTypeKey(Effect.succeed(false))
      )
    },
    success: Schema.Struct({ tools: Schema.Array(EffectiveTool) }),
    error: ApiNotFoundError
  }).annotate(RequiredAccess, "administrative"))
  .add(HttpApiEndpoint.post("replaceProfileTools", "/v1/profiles/:id/tools", {
    params: { id: ProfileId },
    payload: ReplaceProfileToolsBody,
    success: Schema.Struct({ tools: Schema.Array(ProfileTool) }),
    error: [ApiNotFoundError, ApiBadRequestError]
  }).annotate(RequiredAccess, "administrative"))
  .add(HttpApiEndpoint.get("listApprovalRules", "/v1/profiles/:id/approval-rules", {
    params: { id: ProfileId },
    success: Schema.Struct({ rules: Schema.Array(ApprovalRule) }),
    error: ApiNotFoundError
  }).annotate(RequiredAccess, "administrative"))
  .add(HttpApiEndpoint.post("updateApprovalRule", "/v1/approval-rules/:id", {
    params: { id: ApprovalRuleId }, payload: ArgumentPattern, success: ApprovalRule,
    error: [ApiNotFoundError, ApiBadRequestError]
  }).annotate(RequiredAccess, "administrative"))
  .add(HttpApiEndpoint.delete("deleteApprovalRule", "/v1/approval-rules/:id", {
    params: { id: ApprovalRuleId }, success: Schema.Struct({ deleted: Schema.Literal(true) }),
    error: ApiNotFoundError
  }).annotate(RequiredAccess, "administrative"))
  .add(HttpApiEndpoint.get("listApprovalDestinations", "/v1/approval-destinations", {
    success: Schema.Struct({ destinations: Schema.Array(ApprovalDestination) })
  }).annotate(RequiredAccess, "administrative"))
  .add(HttpApiEndpoint.post("createApprovalDestination", "/v1/approval-destinations", {
    payload: CreateApprovalDestinationBody,
    success: HttpApiSchema.status(201)(Schema.Struct({ destination: ApprovalDestination, signingSecret: Schema.String })),
    error: ApiBadRequestError
  }).annotate(RequiredAccess, "administrative"))
  .add(HttpApiEndpoint.delete("deleteApprovalDestination", "/v1/approval-destinations/:id", {
    params: { id: ApprovalDestinationId },
    success: Schema.Struct({ deleted: Schema.Literal(true) })
  }).annotate(RequiredAccess, "administrative"))
  .add(HttpApiEndpoint.get("getProfileApprovalDestinations", "/v1/profiles/:id/approval-destinations", {
    params: { id: ProfileId },
    success: Schema.Struct({ destinationIds: Schema.Array(ApprovalDestinationId) }),
    error: ApiNotFoundError
  }).annotate(RequiredAccess, "administrative"))
  .add(HttpApiEndpoint.post("replaceProfileApprovalDestinations", "/v1/profiles/:id/approval-destinations", {
    params: { id: ProfileId }, payload: ReplaceProfileApprovalDestinationsBody,
    success: Schema.Struct({ destinationIds: Schema.Array(ApprovalDestinationId) }),
    error: [ApiNotFoundError, ApiBadRequestError]
  }).annotate(RequiredAccess, "administrative"))
  .add(HttpApiEndpoint.post("issueKey", "/v1/profiles/:id/keys", {
    params: { id: ProfileId },
    payload: Schema.Struct({ name: Schema.String }),
    success: HttpApiSchema.status(201)(Schema.Struct({
      id: ApiKeyId,
      profileId: ProfileId,
      name: Schema.String,
      secret: Schema.String
    })),
    error: [ApiNotFoundError, ApiBadRequestError]
  }).annotate(RequiredAccess, "administrative"))
  .add(HttpApiEndpoint.get("listKeys", "/v1/profiles/:id/keys", {
    params: { id: ProfileId },
    success: Schema.Struct({ keys: Schema.Array(ApiKeyView) }),
    error: ApiNotFoundError
  }).annotate(RequiredAccess, "administrative"))
  .add(HttpApiEndpoint.post("revokeKey", "/v1/keys/:id/revoke", {
    params: { id: ApiKeyId },
    success: Schema.Struct({ revoked: Schema.Literal(true), key: ApiKeyId })
  }).annotate(RequiredAccess, "administrative"))
  .add(HttpApiEndpoint.post("revokeProfile", "/v1/profiles/:id/revoke", {
    params: { id: ProfileId },
    success: Schema.Struct({
      revoked: Schema.Literal(true),
      cancelledApprovals: Schema.Number
    }),
    error: ApiNotFoundError
  }).annotate(RequiredAccess, "administrative"))
  .add(HttpApiEndpoint.get("events", "/v1/events", {
    success: HttpApiSchema.StreamSse({ data: GatewayEvent })
  }).annotate(RequiredAccess, "administrative"))
  .add(HttpApiEndpoint.get("listApprovals", "/v1/approvals", {
    query: { status: Schema.optional(ApprovalStatus) },
    success: Schema.Struct({ approvals: Schema.Array(ListedApproval) })
  }).annotate(RequiredAccess, "administrative"))
  .add(HttpApiEndpoint.post("approve", "/v1/approvals/:id/approve", {
    params: { id: ApprovalId },
    success: Schema.Struct({
      approval: PendingApproval,
      outcome: SettledOutcome
    }),
    error: [ApiNotFoundError, ApiBadRequestError]
  }).annotate(RequiredAccess, "human"))
  .add(HttpApiEndpoint.post("decideApprovals", "/v1/approvals/decide", {
    payload: Schema.Struct({
      verdict: ApprovalVerdict,
      ids: Schema.NonEmptyArray(ApprovalId).check(Schema.isMaxLength(500)),
      /** Also approve every later call to this tool that fits the pattern these calls share. */
      remember: Schema.optional(Schema.Boolean)
    }),
    success: Schema.Struct({ results: Schema.Array(DecidedApproval), rule: Schema.optional(ApprovalRule) }),
    error: ApiBadRequestError
  }).annotate(RequiredAccess, "human"))
  .add(HttpApiEndpoint.post("deny", "/v1/approvals/:id/deny", {
    params: { id: ApprovalId },
    success: Schema.Struct({ approval: PendingApproval }),
    error: [ApiNotFoundError, ApiBadRequestError]
  }).annotate(RequiredAccess, "human"))
  .add(HttpApiEndpoint.post("refreshDrift", "/v1/drift/refresh", {
    query: { integration: Schema.optional(Schema.String) },
    success: Schema.Struct({ reports: Schema.Array(DriftReport) }),
    error: ApiBadRequestError
  }).annotate(RequiredAccess, "administrative"))
  .add(HttpApiEndpoint.post("maintenance", "/v1/maintenance", {
    success: MaintenanceReport
  }).annotate(RequiredAccess, "administrative"))
  .add(HttpApiEndpoint.get("audit", "/v1/audit", {
    query: {
      since: Schema.optional(Schema.DateFromString),
      outcome: Schema.optional(AuditOutcome),
      profileId: Schema.optional(ProfileId),
      alias: Schema.optional(Alias),
      tool: Schema.optional(Schema.String),
      limit: PositiveIntFromString.pipe(
        Schema.withDecodingDefaultTypeKey(Effect.succeed(PositiveInt.make(50)))
      ),
      offset: NonNegativeIntFromString.pipe(
        Schema.withDecodingDefaultTypeKey(Effect.succeed(NonNegativeInt.make(0)))
      )
    },
    success: Schema.Struct({
      records: Schema.Array(AuditRecord),
      total: Schema.Number,
      limit: PositiveInt,
      offset: NonNegativeInt
    })
  }).annotate(RequiredAccess, "administrative"))
  .middleware(Authority)

const ProvidersView = Schema.Struct({
  signupOpen: Schema.Boolean,
  google: Schema.Union([
    Schema.Struct({ enabled: Schema.Literal(false) }),
    Schema.Struct({
      enabled: Schema.Literal(true),
      startUrl: Schema.String,
      callbackUrl: Schema.String
    })
  ])
})

const CliStartView = Schema.Struct({
  requestId: Schema.String,
  authorizationUrl: Schema.String,
  expiresAt: Schema.Date,
  intervalMs: Schema.Number
})

const CliPollView = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("pending"),
    expiresAt: Schema.Date
  }),
  Schema.Struct({
    status: Schema.Literal("authenticated"),
    token: Schema.String,
    email: Schema.String
  })
])

const MeView = Schema.Union([
  Schema.Struct({
    authenticated: Schema.Literal(true),
    kind: Schema.Literal("session"),
    email: Schema.String,
    tenantId: Schema.String,
    subjectId: SubjectId,
    hasPassword: Schema.Boolean,
    identityProviders: Schema.Array(Schema.String)
  }),
  Schema.Struct({
    authenticated: Schema.Literal(true),
    kind: Schema.Literal("profile"),
    profileId: ProfileId,
    tenantId: Schema.String,
    capabilities: Schema.Array(ProfileCapability)
  }),
  Schema.Struct({
    authenticated: Schema.Literal(true),
    kind: Schema.Literal("local"),
    profileId: ProfileId,
    tenantId: Schema.String
  }),
  Schema.Struct({ authenticated: Schema.Literal(false) })
])

const AuthGroup = HttpApiGroup.make("auth")
  .add(HttpApiEndpoint.get("providers", "/v1/auth/providers", {
    success: ProvidersView
  }).annotate(RequiredAccess, "public"))
  .add(HttpApiEndpoint.post("cliStart", "/v1/auth/cli/start", {
    success: HttpApiSchema.status(201)(CliStartView),
    error: ApiNotImplementedError
  }).annotate(RequiredAccess, "public"))
  .add(HttpApiEndpoint.get("cliPoll", "/v1/auth/cli/:id", {
    params: { id: Schema.String },
    success: CliPollView,
    error: [HandoffUnknownError, HandoffExpiredError, HandoffCollectedError, HandoffRaceError]
  }).annotate(RequiredAccess, "public"))
  .add(HttpApiEndpoint.get("googleStart", "/v1/auth/google/start", {
    query: {
      handoff: Schema.optional(Schema.String),
      returnTo: Schema.optional(Schema.String)
    },
    success: Schema.Struct({ redirected: Schema.Literal(true) })
  }).annotate(RequiredAccess, "public"))
  .add(HttpApiEndpoint.get("googleCallback", "/v1/auth/google/callback", {
    query: {
      state: Schema.optional(Schema.String),
      code: Schema.optional(Schema.String)
    },
    success: Schema.Struct({ rendered: Schema.Literal(true) })
  }).annotate(RequiredAccess, "public"))
  .add(HttpApiEndpoint.post("signup", "/v1/auth/signup", {
    payload: SignupBody,
    success: HttpApiSchema.status(201)(Schema.Struct({
      tenant: Schema.Struct({ id: Schema.String, name: Schema.String }),
      subjectId: SubjectId,
      email: Schema.String
    })),
    error: [SignupClosedError, ApiBadRequestError]
  }).annotate(RequiredAccess, "public"))
  .add(HttpApiEndpoint.post("login", "/v1/auth/login", {
    payload: LoginBody,
    success: Schema.Struct({ email: Schema.String, subjectId: SubjectId }),
    error: InvalidCredentialsError
  }).annotate(RequiredAccess, "public"))
  .add(HttpApiEndpoint.post("logout", "/v1/auth/logout", {
    success: Schema.Struct({ loggedOut: Schema.Literal(true) })
  }).annotate(RequiredAccess, "public"))
  .add(HttpApiEndpoint.get("whoami", "/v1/auth/me", {
    success: MeView
  }).annotate(RequiredAccess, "public"))
  .add(HttpApiEndpoint.post("changeEmail", "/v1/auth/email", {
    payload: ChangeEmailBody,
    success: Schema.Struct({ email: Schema.String }),
    error: [ForbiddenError, ApiBadRequestError, InvalidCredentialsError]
  }).annotate(RequiredAccess, "human"))
  .add(HttpApiEndpoint.post("changePassword", "/v1/auth/password", {
    payload: ChangePasswordBody,
    success: Schema.Struct({
      updated: Schema.Literal(true),
      revokedSessions: Schema.Number
    }),
    error: [ForbiddenError, InvalidCredentialsError]
  }).annotate(RequiredAccess, "human"))
  .add(HttpApiEndpoint.post("deleteAccount", "/v1/auth/account/delete", {
    payload: DeleteAccountBody,
    success: Schema.Struct({ deleted: Schema.Literal(true) }),
    error: [ForbiddenError, PasswordRequiredError, InvalidCredentialsError]
  }).annotate(RequiredAccess, "human"))
  .middleware(Authority)

const OAuthGroup = HttpApiGroup.make("oauth")
  .add(HttpApiEndpoint.get("consent", "/v1/oauth/authorization-request", {
    query: { id: Schema.String },
    success: OAuthConsentView,
    error: [ApiNotFoundError, ApiGoneError]
  }).annotate(RequiredAccess, "human"))
  .add(HttpApiEndpoint.post("decideConsent", "/v1/oauth/authorization-request", {
    query: { id: Schema.String },
    payload: OAuthConsentDecision,
    success: Schema.Struct({ redirect: Schema.String }),
    error: [ApiNotFoundError, ApiGoneError, ApiBadRequestError]
  }).annotate(RequiredAccess, "human"))
  .add(HttpApiEndpoint.get("listGrants", "/v1/oauth/grants", {
    success: Schema.Struct({ grants: Schema.Array(OAuthGrantView) })
  }).annotate(RequiredAccess, "human"))
  .add(HttpApiEndpoint.delete("revokeGrant", "/v1/oauth/grants/:id", {
    params: { id: OAuthGrantId },
    success: Schema.Struct({ revoked: Schema.Boolean })
  }).annotate(RequiredAccess, "human"))
  .middleware(Authority)

export const GatewayApi = HttpApi.make("@integragents/gateway-api/gateway")
  .add(SystemGroup)
  .add(FallbackGroup)
  .add(DelegatedGroup)
  .add(ProvisioningGroup)
  .add(AdministrativeGroup)
  .add(AuthGroup)
  .add(OAuthGroup)

export {
  ApiBadRequest,
  ApiGone,
  ApiNotFound,
  ApiNotImplemented,
  Authority,
  Forbidden,
  GatewayFailure,
  HandoffCollected,
  HandoffExpired,
  HandoffUnknown,
  InvalidCredentials,
  PasswordRequired,
  SignupClosed
}
