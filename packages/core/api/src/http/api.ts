import { Effect, Schema } from "effect"
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema
} from "effect/unstable/httpapi"
import {
  ApprovalDelivery,
  ApprovalId,
  ApprovalStatus,
  AuditOutcome,
  AuditRecord,
  Client,
  ClientCapability,
  ClientId,
  Alias,
  ApiKeyId,
  Grant,
  GrantId,
  GrantDecision,
  PendingApproval,
  SubjectId
} from "@mokronos/gateway-core"
import {
  BooleanFromString,
  Connection,
  GatewayMetadata,
  IntegrationDiscovery,
  IntegrationSearchKind,
  IntegrationSearchResponse,
  IntegrationValidationReport,
  IntegrationOverview,
  NonNegativeInt,
  NonNegativeIntFromString,
  PositiveInt,
  PositiveIntFromString,
  Tool,
  ToolAddress,
  ToolSummary
} from "@mokronos/contracts"
import { Authority } from "./authority.ts"
import { ForbiddenError, RequiredAccess, Unmetered } from "./identity.ts"

// --- shared wire shapes -----------------------------------------------------

const Json = Schema.Json

/** An alias arrives on the wire as prose-typed JSON; validating its shape here
 *  turns a malformed one into an automatic 400 instead of a handler defect. */
const WireAlias = Alias

const ExecuteBody = Schema.Struct({
  alias: WireAlias,
  tool: Schema.String,
  arguments: Schema.optional(Json)
})

const ConnectionRefBody = Schema.Union([
  Schema.Struct({
    owner: Schema.Literal("org"),
    integration: Schema.String,
    name: Schema.String
  }),
  Schema.Struct({
    owner: Schema.Literal("user"),
    subject: Schema.String,
    integration: Schema.String,
    name: Schema.String
  })
])

const CreateClientBody = Schema.Struct({
  name: Schema.String,
  capabilities: Schema.optional(Schema.Array(ClientCapability)),
  approvalDelivery: Schema.optional(ApprovalDelivery)
})

const UpdateClientSettingsBody = Schema.Struct({
  capabilities: Schema.Array(ClientCapability),
  approvalDelivery: ApprovalDelivery
})

const CreateGrantBody = Schema.Struct({
  clientId: ClientId,
  alias: WireAlias,
  tool: Schema.String,
  connection: ConnectionRefBody,
  decision: Schema.optional(Schema.Literals(["allow", "require_approval"]))
})

const DiscoverBody = Schema.Struct({
  url: Schema.String,
  connection: Schema.optional(Schema.String)
})

const ConnectBody = Schema.Struct({
  integration: Schema.String,
  connection: Schema.optional(Schema.String),
  template: Schema.optional(Schema.String),
  /** Credential values, resolved from the environment by the *client* before
   *  they get here. The gateway never reads a caller's environment. */
  values: Schema.optional(Schema.Record(Schema.String, Schema.String))
})

const OAuthStartBody = Schema.Struct({
  integration: Schema.String,
  connection: Schema.optional(Schema.String),
  template: Schema.optional(Schema.String),
  clientId: Schema.optional(Schema.String),
  clientSecret: Schema.optional(Schema.String),
  timeoutSeconds: Schema.optional(Schema.Number)
})

const InvokeAddressBody = Schema.Struct({
  address: ToolAddress,
  arguments: Schema.optional(Json)
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
  /** The one strength rule enforced structurally; scrypt compensates for
   *  complexity, never for length. */
  password: Schema.String.check(Schema.isMinLength(8)),
  tenantName: Schema.optional(Schema.String)
})

export const LoginBody = Schema.Struct({
  email: Email,
  password: Schema.String
})

export const ChangeEmailBody = Schema.Struct({
  email: Email,
  /** Re-authentication on the way in: whoever can type the current password
   *  may redirect the account, and a hijacked tab cannot. */
  password: Schema.String
})

export const ChangePasswordBody = Schema.Struct({
  currentPassword: Schema.optional(Schema.String),
  newPassword: Schema.String.check(Schema.isMinLength(8))
})

export const DeleteAccountBody = Schema.Struct({
  password: Schema.optional(Schema.String)
})

/** A granted tool as `/v1/tools` reports it. Schemas are opt-in because
 *  fetching them costs a catalog read per grant. */
const GrantedTool = Schema.Struct({
  alias: Alias,
  tool: Schema.String,
  integration: Schema.String,
  decision: GrantDecision,
  inputSchema: Schema.optional(Json),
  outputSchema: Schema.optional(Json)
})

/** One invocation, three endings. A frozen call is not an error: the caller
 *  gets an identifier to poll and suspends rather than failing. The statuses
 *  are part of the answer, declared here so the encoded response cannot drift
 *  from what a caller branches on. */
const InvokedOk = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("succeeded"),
    result: Json
  }),
  Schema.Struct({
    status: Schema.Literal("pending"),
    approvalId: ApprovalId,
    expiresAt: Schema.Date,
    approvalUrl: Schema.optional(Schema.String)
  })
])
const InvokedDenied = Schema.Struct({
  status: Schema.Literal("denied"),
  reason: Schema.String
}).pipe(HttpApiSchema.status(403))
const InvokedFailed = Schema.Struct({
  status: Schema.Literal("failed"),
  message: Schema.String
}).pipe(HttpApiSchema.status(502))

const SettledOutcome = Schema.Union([
  Schema.Struct({ status: Schema.Literal("succeeded"), result: Json }),
  Schema.Struct({ status: Schema.Literal("failed"), message: Schema.String })
])

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
  expiredIdentityFlows: Schema.Number
})

const OAuthSessionState = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("pending"),
    authorizationUrl: Schema.String
  }),
  Schema.Struct({
    status: Schema.Literal("connected"),
    connection: Connection
  }),
  Schema.Struct({
    status: Schema.Literal("failed"),
    message: Schema.String
  })
])
const OAuthSessionView = Schema.Struct({
  id: Schema.String,
  integration: Schema.String,
  connection: Schema.String,
  state: OAuthSessionState
})

// --- shared errors ----------------------------------------------------------

/** Endpoint-level refusals. Each carries its status as an annotation, so the
 *  encoded response and the documented API cannot disagree. */
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

/** Every endpoint can refuse a caller, so the authority's errors ride on the
 *  groups through its middleware rather than being named endpoint by endpoint. */

// --- system -----------------------------------------------------------------

const SystemGroup = HttpApiGroup.make("system")
  .add(HttpApiEndpoint.get("health", "/v1/health", {
    success: Schema.Struct({ ok: Schema.Literal(true) })
  }).annotate(Unmetered, true).annotate(RequiredAccess, "public"))
  .add(HttpApiEndpoint.get("metadata", "/v1/metadata", {
    success: GatewayMetadata
  }).annotate(Unmetered, true).annotate(RequiredAccess, "public"))
  .middleware(Authority)

/** Unmatched requests land here instead of the router's bare empty 404, so a
 *  wrong method still says which paths exist and an unknown path answers in
 *  the same JSON dialect as everything else. */
const FallbackGroup = HttpApiGroup.make("fallback")
  .add(HttpApiEndpoint.make("GET")("unmatchedGet", "/*", {
    params: { "*": Schema.String },
    success: Schema.Never.pipe(HttpApiSchema.status(404))
  }).annotate(Unmetered, true).annotate(RequiredAccess, "public"))
  .add(HttpApiEndpoint.make("POST")("unmatchedPost", "/*", {
    params: { "*": Schema.String },
    success: Schema.Never.pipe(HttpApiSchema.status(404))
  }).annotate(Unmetered, true).annotate(RequiredAccess, "public"))
  .add(HttpApiEndpoint.make("DELETE")("unmatchedDelete", "/*", {
    params: { "*": Schema.String },
    success: Schema.Never.pipe(HttpApiSchema.status(404))
  }).annotate(Unmetered, true).annotate(RequiredAccess, "public"))
  .middleware(Authority)// --- delegated --------------------------------------------------------------

const DelegatedGroup = HttpApiGroup.make("delegated")
  .add(HttpApiEndpoint.get("listTools", "/v1/tools", {
    query: {
      schemas: BooleanFromString.pipe(
        Schema.withDecodingDefaultTypeKey(Effect.succeed(false))
      )
    },
    success: Schema.Struct({ tools: Schema.Array(GrantedTool) })
  }).annotate(RequiredAccess, "delegated"))
  .add(HttpApiEndpoint.post("execute", "/v1/execute", {
    payload: ExecuteBody,
    success: [InvokedOk, InvokedDenied, InvokedFailed]
  }).annotate(RequiredAccess, "delegated"))
  .add(HttpApiEndpoint.get("approval", "/v1/approvals/:id", {
    params: { id: ApprovalId },
    success: PendingApproval,
    error: ApiNotFoundError
  }).annotate(RequiredAccess, "delegated"))
  .middleware(Authority)

// --- provisioning -----------------------------------------------------------

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
    // The URL is the caller's, and so is an unreachable host or a document that
    // is not a spec. Declared here so it answers rather than breaks.
    error: ApiBadRequestError
  }).annotate(RequiredAccess, "provisioning"))
  .add(HttpApiEndpoint.get("integrationTools", "/v1/integrations/:slug/tools", {
    params: { slug: Schema.String },
    success: Schema.Struct({ tools: Schema.Array(ToolSummary) })
  }).annotate(RequiredAccess, "provisioning"))
  .add(HttpApiEndpoint.get("describeTool", "/v1/integrations/:slug/tools/:tool", {
    params: { slug: Schema.String, tool: Schema.String },
    query: { connection: Schema.optional(Schema.String) },
    success: Tool
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
  .add(HttpApiEndpoint.post("invokeTool", "/v1/tools/invoke", {
    payload: InvokeAddressBody,
    success: Json,
    error: ApiBadRequestError
  }).annotate(RequiredAccess, "administrative"))
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
  .add(HttpApiEndpoint.get("oauthCallback", "/v1/oauth/callback", {
    query: {
      state: Schema.optional(Schema.String),
      code: Schema.optional(Schema.String),
      error_description: Schema.optional(Schema.String),
      error: Schema.optional(Schema.String),
      domain: Schema.optional(Schema.String),
      site: Schema.optional(Schema.String)
    },
    // The provider's redirect lands here; every answer is a page for a human.
    success: Schema.Struct({ rendered: Schema.Literal(true) })
  }).annotate(RequiredAccess, "public"))
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

// --- administrative ---------------------------------------------------------

const KeyView = Schema.Struct({
  id: ApiKeyId,
  clientId: ClientId,
  createdAt: Schema.Date,
  lastUsedAt: Schema.NullOr(Schema.Date),
  revokedAt: Schema.NullOr(Schema.Date)
})

const AdministrativeGroup = HttpApiGroup.make("administrative")
  .add(HttpApiEndpoint.get("overview", "/v1/overview", {
    success: Schema.Struct({
      clients: Schema.Number,
      grants: Schema.Number,
      keys: Schema.Number,
      pendingApprovals: Schema.Number,
      connections: Schema.Number,
      recentActivity: Schema.Array(AuditRecord)
    })
  }).annotate(RequiredAccess, "administrative"))
  .add(HttpApiEndpoint.get("listClients", "/v1/clients", {
    success: Schema.Struct({ clients: Schema.Array(Client) })
  }).annotate(RequiredAccess, "administrative"))
  .add(HttpApiEndpoint.post("createClient", "/v1/clients", {
    payload: CreateClientBody,
    success: HttpApiSchema.status(201)(Client),
    error: ApiBadRequest
  }).annotate(RequiredAccess, "administrative"))
  .add(HttpApiEndpoint.post("updateClientSettings", "/v1/clients/:id/settings", {
    params: { id: ClientId },
    payload: UpdateClientSettingsBody,
    success: Client,
    error: [ApiNotFoundError, ApiBadRequestError]
  }).annotate(RequiredAccess, "administrative"))
  .add(HttpApiEndpoint.post("issueKey", "/v1/clients/:id/keys", {
    params: { id: ClientId },
    success: HttpApiSchema.status(201)(Schema.Struct({
      id: ApiKeyId,
      clientId: ClientId,
      secret: Schema.String
    })),
    error: ApiNotFoundError
  }).annotate(RequiredAccess, "administrative"))
  .add(HttpApiEndpoint.get("listKeys", "/v1/clients/:id/keys", {
    params: { id: ClientId },
    success: Schema.Struct({ keys: Schema.Array(KeyView) }),
    error: ApiNotFoundError
  }).annotate(RequiredAccess, "administrative"))
  .add(HttpApiEndpoint.post("revokeKey", "/v1/keys/:id/revoke", {
    params: { id: ApiKeyId },
    success: Schema.Struct({ revoked: Schema.Literal(true), key: ApiKeyId })
  }).annotate(RequiredAccess, "administrative"))
  .add(HttpApiEndpoint.get("clientTools", "/v1/clients/:id/tools", {
    params: { id: ClientId },
    query: {
      schemas: BooleanFromString.pipe(
        Schema.withDecodingDefaultTypeKey(Effect.succeed(false))
      )
    },
    success: Schema.Struct({ tools: Schema.Array(GrantedTool) }),
    error: ApiNotFoundError
  }).annotate(RequiredAccess, "administrative"))
  .add(HttpApiEndpoint.post("revokeClient", "/v1/clients/:id/revoke", {
    params: { id: ClientId },
    success: Schema.Struct({
      revoked: Schema.Literal(true),
      cancelledApprovals: Schema.Number
    }),
    error: ApiNotFoundError
  }).annotate(RequiredAccess, "administrative"))
  .add(HttpApiEndpoint.get("listGrants", "/v1/grants", {
    query: { clientId: ClientId },
    success: Schema.Struct({ grants: Schema.Array(Grant) })
  }).annotate(RequiredAccess, "administrative"))
  .add(HttpApiEndpoint.post("createGrant", "/v1/grants", {
    payload: CreateGrantBody,
    success: HttpApiSchema.status(201)(Grant),
    error: [ApiNotFoundError, ApiBadRequestError]
  }).annotate(RequiredAccess, "administrative"))
  .add(HttpApiEndpoint.post("revokeGrant", "/v1/grants/:id/revoke", {
    params: { id: GrantId },
    success: Schema.Struct({ revoked: Schema.Literal(true) })
  }).annotate(RequiredAccess, "administrative"))
  .add(HttpApiEndpoint.get("listApprovals", "/v1/approvals", {
    query: { status: Schema.optional(ApprovalStatus) },
    success: Schema.Struct({ approvals: Schema.Array(PendingApproval) })
  }).annotate(RequiredAccess, "administrative"))
  .add(HttpApiEndpoint.post("approve", "/v1/approvals/:id/approve", {
    params: { id: ApprovalId },
    success: Schema.Struct({
      approval: PendingApproval,
      outcome: SettledOutcome
    }),
    error: [ApiNotFoundError, ApiBadRequestError]
  }).annotate(RequiredAccess, "human"))
  .add(HttpApiEndpoint.post("deny", "/v1/approvals/:id/deny", {
    params: { id: ApprovalId },
    success: Schema.Struct({ approval: PendingApproval }),
    error: ApiNotFoundError
  }).annotate(RequiredAccess, "human"))
  .add(HttpApiEndpoint.post("refreshDrift", "/v1/drift/refresh", {
    query: { integration: Schema.optional(Schema.String) },
    success: Schema.Struct({ reports: Schema.Array(DriftReport) })
  }).annotate(RequiredAccess, "administrative"))
  .add(HttpApiEndpoint.post("maintenance", "/v1/maintenance", {
    success: MaintenanceReport
  }).annotate(RequiredAccess, "administrative"))
  .add(HttpApiEndpoint.get("audit", "/v1/audit", {
    query: {
      since: Schema.optional(Schema.DateFromString),
      outcome: Schema.optional(AuditOutcome),
      clientId: Schema.optional(ClientId),
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

// --- auth -------------------------------------------------------------------

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
    kind: Schema.Literal("client"),
    clientId: ClientId,
    tenantId: Schema.String,
    capabilities: Schema.Array(ClientCapability)
  }),
  Schema.Struct({
    authenticated: Schema.Literal(true),
    kind: Schema.Literal("local"),
    clientId: ClientId,
    tenantId: Schema.String
  }),
  Schema.Struct({ authenticated: Schema.Literal(false) })
])

/** The browser-facing session surface answers with cookies alongside JSON, so
 *  several of these handlers build raw responses; their schemas remain honest
 *  declarations of the shape a successful body carries. */
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

/** The whole gateway surface, as data. */
export const GatewayApi = HttpApi.make("@mokronos/integrations/gateway")
  .add(SystemGroup)
  .add(FallbackGroup)
  .add(DelegatedGroup)
  .add(ProvisioningGroup)
  .add(AdministrativeGroup)
  .add(AuthGroup)

export {
  ApiBadRequest,
  ApiNotFound,
  ApiNotImplemented,
  HandoffCollected,
  HandoffExpired,
  HandoffUnknown,
  InvalidCredentials,
  PasswordRequired,
  SignupClosed
}
