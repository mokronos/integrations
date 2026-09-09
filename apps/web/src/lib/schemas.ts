import { Option, Schema } from "effect"
import {
  ApiKeyView,
  Alias,
  ApprovalStatus as ApprovalStatusSchema,
  AuditRecord,
  AuditOutcome,
  Client,
  DriftEntry,
  ConnectionRef as ConnectionRefSchema,
  AccessProfile,
  AccessProfileTool,
  ApprovalPolicy,
  ApprovalPolicyTool,
  ApprovalDestination,
  ApprovalDeliveryAttempt,
  PolicyDecision as PolicyDecisionSchema,
  PendingApproval
} from "@integrations/contracts"
import { IntegrationSearchKind } from "@integrations/contracts"
import {
  AuthMethod,
  Connection,
  Tool,
  ToolSummary,
  IntegrationOverview
} from "@integrations/contracts"

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

export type { ApprovalDestination, ApprovalDeliveryAttempt }

export { ApprovalStatusSchema, ConnectionRefSchema, PolicyDecisionSchema }
export type {
  ApprovalStatus,
  ApprovalDelivery,
  ClientId,
  ConnectionRef,
  PolicyDecision,
  ApprovalDestinationId
} from "@integrations/contracts"




export const AccessProfileSummary = Schema.Struct({
  accessProfile: AccessProfile,
  connectionCount: Schema.Number,
  integrationCount: Schema.Number,
  toolCount: Schema.Number,
  assignedClientCount: Schema.Number
})
export type AccessProfileSummary = typeof AccessProfileSummary.Type

export const ApprovalPolicySummary = Schema.Struct({
  approvalPolicy: ApprovalPolicy,
  connectionCount: Schema.Number,
  integrationCount: Schema.Number,
  toolCount: Schema.Number,
  assignedClientCount: Schema.Number
})
export type ApprovalPolicySummary = typeof ApprovalPolicySummary.Type

export const EffectiveTool = Schema.Struct({
  alias: Alias,
  tool: Schema.String,
  connection: ConnectionRefSchema,
  decision: PolicyDecisionSchema,
  inputSchema: Schema.optional(Schema.Json),
  outputSchema: Schema.optional(Schema.Json)
})
export type EffectiveTool = typeof EffectiveTool.Type


export const AccessProfileToolInput = Schema.Struct({
  connection: ConnectionRefSchema,
  tool: Schema.String
})
export type AccessProfileToolInput = typeof AccessProfileToolInput.Type
export const ApprovalPolicyToolInput = Schema.Struct({ connection: ConnectionRefSchema, tool: Schema.String, decision: PolicyDecisionSchema })
export type ApprovalPolicyToolInput = typeof ApprovalPolicyToolInput.Type


export const AuditResponse = Schema.Struct({
  records: Schema.Array(AuditRecord),
  total: Schema.Number,
  limit: Schema.Number,
  offset: Schema.Number
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

export const ApiKeySummary = ApiKeyView
export type ApiKeySummary = typeof ApiKeySummary.Type



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


export const Revoked = Schema.Struct({
  revoked: Schema.Boolean,
  cancelledApprovals: Schema.optional(Schema.Number)
})
export type Revoked = typeof Revoked.Type


export const IntegrationRemoved = Schema.Struct({
  removed: Schema.Boolean,
  integration: Schema.String,
  connections: Schema.Array(Schema.String)
})
export type IntegrationRemoved = typeof IntegrationRemoved.Type


export const decodeApprovalFilter = Schema.decodeUnknownSync(
  Schema.Union([ApprovalStatusSchema, Schema.Literal("all")])
)
export const decodeIntegrationSearchFilter = Schema.decodeUnknownSync(
  Schema.Union([IntegrationSearchKind, Schema.Literal("__all__")])
)
export const decodeAuditOutcomeFilter = Schema.decodeUnknownSync(
  Schema.Union([AuditOutcome, Schema.Literal("all")])
)


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



const decodeInstant = Schema.decodeUnknownOption(
  Schema.DateFromString
)

export const instantFilter = (value: string): string | undefined =>
  Option.getOrUndefined(Option.map(decodeInstant(value), (date) => date.toISOString()))
