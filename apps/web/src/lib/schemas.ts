import { Option, Schema } from "effect"
import {
  ApiKey,
  Alias,
  ApprovalStatus as ApprovalStatusSchema,
  AuditRecord,
  AuditOutcome,
  Client,
  DriftEntry,
  ConnectionRef as ConnectionRefSchema,
  AccessProfile,
  AccessProfileId,
  AccessProfileTool,
  ApprovalPolicy,
  ApprovalPolicyId,
  ApprovalPolicyTool,
  PolicyDecision as PolicyDecisionSchema,
  PendingApproval
} from "@mokronos/gateway-core/domain"
import { IntegrationDiscovery } from "@mokronos/contracts"
import {
  IntegrationSearchKind,
  IntegrationSearchResponse
} from "@mokronos/contracts"
import {
  AuthMethod,
  Connection,
  Tool,
  ToolSummary,
  IntegrationOverview
} from "@mokronos/contracts"

/** What the gateway's responses decode to.
 *
 * The gateway's own domain schemas are the source of truth — this module does
 * not restate them. `Schema.toCodecJson` derives the JSON form of each one, so
 * an ISO string on the wire arrives here as a `Date`, a branded id stays
 * branded, and a field that changes shape in `domain.ts` fails to decode here
 * rather than rendering as `undefined` somewhere three screens away.
 */

export type {
  AuditRecord,
  AuditOutcome,
  Client,
  DriftEntry,
  AuthMethod,
  Connection,
  Tool,
  ToolSummary,
  IntegrationOverview,
  AccessProfile,
  AccessProfileTool,
  ApprovalPolicy,
  ApprovalPolicyTool,
  PendingApproval
}

export { ApprovalStatusSchema, ConnectionRefSchema, PolicyDecisionSchema }
export type {
  ApprovalStatus,
  ApprovalDelivery,
  ClientId,
  ConnectionRef,
  PolicyDecision,
  AccessProfileId,
  ApprovalPolicyId
} from "@mokronos/gateway-core/domain"

/** Derives the JSON codec for a schema and returns a decoder for it. Every
 *  response in this module goes through here, so no shape reaches a component
 *  unparsed. */
const json = <T, E>(schema: Schema.Codec<T, E>) =>
  Schema.decodeUnknownSync(Schema.toCodecJson(schema))

export const IntegrationsResponse = Schema.Struct({
  integrations: Schema.Array(IntegrationOverview),
  oauthCallbackUrl: Schema.optional(Schema.NullOr(Schema.String))
})

export const ConnectionsResponse = Schema.Struct({
  connections: Schema.Array(Connection)
})

export const ClientsResponse = Schema.Struct({
  clients: Schema.Array(Client)
})

export const AccessProfileSummary = Schema.Struct({
  accessProfile: AccessProfile,
  connectionCount: Schema.Number,
  integrationCount: Schema.Number,
  toolCount: Schema.Number,
  assignedClientCount: Schema.Number
})
export type AccessProfileSummary = typeof AccessProfileSummary.Type
export const AccessProfilesResponse = Schema.Struct({ accessProfiles: Schema.Array(AccessProfileSummary) })
export const AccessProfileDetail = Schema.Struct({
  accessProfile: AccessProfile,
  tools: Schema.Array(AccessProfileTool),
  assignedClients: Schema.Array(Client)
})
export const AccessProfileToolsReplaced = Schema.Struct({
  accessProfile: AccessProfile,
  tools: Schema.Array(AccessProfileTool)
})

export const ApprovalPolicySummary = Schema.Struct({
  approvalPolicy: ApprovalPolicy,
  connectionCount: Schema.Number,
  integrationCount: Schema.Number,
  toolCount: Schema.Number,
  assignedClientCount: Schema.Number
})
export type ApprovalPolicySummary = typeof ApprovalPolicySummary.Type
export const ApprovalPoliciesResponse = Schema.Struct({ approvalPolicies: Schema.Array(ApprovalPolicySummary) })
export const ApprovalPolicyDetail = Schema.Struct({ approvalPolicy: ApprovalPolicy, tools: Schema.Array(ApprovalPolicyTool), assignedClients: Schema.Array(Client) })
export const ApprovalPolicyToolsReplaced = Schema.Struct({ approvalPolicy: ApprovalPolicy, tools: Schema.Array(ApprovalPolicyTool) })

export const EffectiveTool = Schema.Struct({
  alias: Alias,
  tool: Schema.String,
  connection: ConnectionRefSchema,
  decision: PolicyDecisionSchema,
  inputSchema: Schema.optional(Schema.Json),
  outputSchema: Schema.optional(Schema.Json)
})
export type EffectiveTool = typeof EffectiveTool.Type

export const EffectiveToolsResponse = Schema.Struct({ tools: Schema.Array(EffectiveTool) })

export const AccessProfileToolInput = Schema.Struct({
  connection: ConnectionRefSchema,
  tool: Schema.String
})
export type AccessProfileToolInput = typeof AccessProfileToolInput.Type
export const ApprovalPolicyToolInput = Schema.Struct({ connection: ConnectionRefSchema, tool: Schema.String, decision: PolicyDecisionSchema })
export type ApprovalPolicyToolInput = typeof ApprovalPolicyToolInput.Type

export const ApprovalsResponse = Schema.Struct({
  approvals: Schema.Array(PendingApproval)
})

export const AuditResponse = Schema.Struct({
  records: Schema.Array(AuditRecord),
  // Optional for rolling upgrades: older gateway processes returned only rows.
  total: Schema.optional(Schema.Number),
  limit: Schema.optional(Schema.Number),
  offset: Schema.optional(Schema.Number)
})
export type AuditResponse = typeof AuditResponse.Type

export const OverviewResponse = Schema.Struct({
  connections: Schema.Number,
  clients: Schema.Number,
  accessProfiles: Schema.Number,
  accessProfileTools: Schema.Number,
  approvalPolicies: Schema.Number,
  approvalPolicyTools: Schema.Number,
  keys: Schema.Number,
  pendingApprovals: Schema.Number,
  recentActivity: Schema.Array(AuditRecord)
})
export type OverviewResponse = typeof OverviewResponse.Type

export const ApiKeySummary = Schema.Struct({
  id: ApiKey.fields.id,
  clientId: ApiKey.fields.clientId,
  createdAt: ApiKey.fields.createdAt,
  lastUsedAt: ApiKey.fields.lastUsedAt,
  revokedAt: ApiKey.fields.revokedAt
})
export type ApiKeySummary = typeof ApiKeySummary.Type

export const KeysResponse = Schema.Struct({ keys: Schema.Array(ApiKeySummary) })

export const ToolsResponse = Schema.Struct({
  tools: Schema.Array(ToolSummary)
})

/** The one and only time a key's plaintext exists outside the holder's hands. */
export const IssuedKey = Schema.Struct({
  id: Schema.String,
  clientId: Schema.String,
  secret: Schema.String
})
export type IssuedKey = typeof IssuedKey.Type

export const ConnectionCreated = Schema.Struct({
  connection: Connection,
  tools: Schema.Array(ToolSummary)
})
export type ConnectionCreated = typeof ConnectionCreated.Type

export const OAuthSession = Schema.Struct({
  id: Schema.String,
  integration: Schema.String,
  connection: Schema.String,
  state: Schema.Union([
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
})
export type OAuthSession = typeof OAuthSession.Type

export const DriftReport = Schema.Struct({
  integration: Schema.String,
  entries: Schema.Array(DriftEntry),
  checkedAt: Schema.Date,
  baseline: Schema.optional(Schema.Boolean)
})
export type DriftReport = typeof DriftReport.Type

export const DriftResponse = Schema.Struct({
  reports: Schema.Array(DriftReport)
})

export const Revoked = Schema.Struct({
  revoked: Schema.Boolean,
  cancelledApprovals: Schema.optional(Schema.Number)
})
export type Revoked = typeof Revoked.Type

export const Removed = Schema.Struct({ removed: Schema.Boolean })

export const decodeIntegrations = json(IntegrationsResponse)
export const decodeConnections = json(ConnectionsResponse)
export const decodeClients = json(ClientsResponse)
export const decodeAccessProfiles = json(AccessProfilesResponse)
export const decodeAccessProfile = json(AccessProfileDetail)
export const decodeAccessProfileCreated = json(AccessProfile)
export const decodeAccessProfileToolsReplaced = json(AccessProfileToolsReplaced)
export const decodeApprovalPolicies = json(ApprovalPoliciesResponse)
export const decodeApprovalPolicy = json(ApprovalPolicyDetail)
export const decodeApprovalPolicyCreated = json(ApprovalPolicy)
export const decodeApprovalPolicyToolsReplaced = json(ApprovalPolicyToolsReplaced)
export const decodeEffectiveTools = json(EffectiveToolsResponse)
export const decodeApprovals = json(ApprovalsResponse)
export const decodeAudit = json(AuditResponse)
export const decodeOverview = json(OverviewResponse)
export const decodeKeys = json(KeysResponse)
export const decodeTools = json(ToolsResponse)
export const decodeTool = json(Tool)
export const decodeIssuedKey = json(IssuedKey)
export const decodeConnectionCreated = json(ConnectionCreated)
export const decodeOAuthSession = json(OAuthSession)
export const decodeDiscovery = json(IntegrationDiscovery)
export const decodeDrift = json(DriftResponse)
export const decodeRevoked = json(Revoked)
export const decodeRemoved = json(Removed)
export const decodeClient = json(Client)
export const decodeRegistrySearch = json(IntegrationSearchResponse)

/** Values arriving from a widget are strings; these turn them back into the
 * domain's own types rather than asserting them. A Select that somehow yields
 * an unknown value fails loudly here instead of silently sending nonsense to
 * the gateway. */
export const decodePolicyDecision = Schema.decodeUnknownSync(PolicyDecisionSchema)
export const decodeAccessProfileId = Schema.decodeUnknownSync(AccessProfileId)
export const decodeApprovalPolicyId = Schema.decodeUnknownSync(ApprovalPolicyId)
export const decodeApprovalFilter = Schema.decodeUnknownSync(
  Schema.Union([ApprovalStatusSchema, Schema.Literal("all")])
)
export const decodeIntegrationSearchFilter = Schema.decodeUnknownSync(
  Schema.Union([IntegrationSearchKind, Schema.Literal("__all__")])
)
export const decodeAuditOutcomeFilter = Schema.decodeUnknownSync(
  Schema.Union([AuditOutcome, Schema.Literal("all")])
)

/** `approve` performs the call, so it answers with both the settled approval
 *  and what the invocation did. */
export const ApprovalDecided = Schema.Struct({
  approval: Schema.NullOr(PendingApproval),
  outcome: Schema.optional(Schema.Json)
})
export const decodeApprovalDecided = json(ApprovalDecided)

/** Who the gateway thinks is asking. A session means a signed-in human; a
 *  client means an API key spoke; neither means the login form belongs on
 *  screen. Mirrors GET /v1/auth/me. */
export const Me = Schema.Union([
  Schema.Struct({
    authenticated: Schema.Literal(true),
    kind: Schema.Literal("session"),
    email: Schema.String,
    tenantId: Schema.String,
    subjectId: Schema.String,
    hasPassword: Schema.Boolean,
    identityProviders: Schema.Array(Schema.Literal("google"))
  }),
  Schema.Struct({
    authenticated: Schema.Literal(true),
    kind: Schema.Literal("client"),
    clientId: Schema.String,
    tenantId: Schema.String,
    capabilities: Schema.Array(Schema.Literals([
      "provision_connections",
      "administer_gateway"
    ]))
  }),
  Schema.Struct({
    authenticated: Schema.Literal(true),
    kind: Schema.Literal("local"),
    clientId: Schema.String,
    tenantId: Schema.String
  }),
  Schema.Struct({
    authenticated: Schema.Literal(false)
  })
])
export type Me = typeof Me.Type

export const decodeMe = json(Me)

export const AuthProviders = Schema.Struct({
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
export type AuthProviders = typeof AuthProviders.Type
export const decodeAuthProviders = json(AuthProviders)

export const EmailChanged = Schema.Struct({ email: Schema.String })
export const PasswordChanged = Schema.Struct({
  updated: Schema.Literal(true),
  revokedSessions: Schema.Number
})
export const AccountDeleted = Schema.Struct({ deleted: Schema.Literal(true) })

export const decodeEmailChanged = json(EmailChanged)
export const decodePasswordChanged = json(PasswordChanged)
export const decodeAccountDeleted = json(AccountDeleted)

/** A `datetime-local` field's value as an instant, or nothing.
 *
 *  The browser constrains the input, but not enough: a partial or impossible
 *  value still reaches here as a string, and `new Date(...).toISOString()` on
 *  one throws mid-render. Asking the schema turns that into an absent filter. */
const decodeInstant = Schema.decodeUnknownOption(
  Schema.DateFromString
)

export const instantFilter = (value: string): string | undefined =>
  Option.getOrUndefined(Option.map(decodeInstant(value), (date) => date.toISOString()))
