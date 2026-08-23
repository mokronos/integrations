import { Schema } from "effect"
import {
  ApiKey,
  ApprovalStatus as ApprovalStatusSchema,
  AuditRecord,
  AuditOutcome,
  Client,
  DriftEntry,
  Grant,
  GrantDecision as GrantDecisionSchema,
  PendingApproval
} from "@mokronos/integrations/domain"
import {
  IntegrationDiscovery,
  IntegrationValidationReport
} from "@mokronos/integrations-executor/integration-model"
import {
  IntegrationSearchKind,
  IntegrationSearchResponse
} from "@mokronos/integrations-executor/registry"
import {
  ExecutorAuthMethod,
  ExecutorConnection,
  ExecutorTool,
  ExecutorToolSummary,
  IntegrationOverview
} from "@mokronos/integrations-executor/schemas"

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
  ExecutorAuthMethod,
  ExecutorConnection,
  ExecutorTool,
  ExecutorToolSummary,
  Grant,
  IntegrationOverview,
  PendingApproval
}

export { ApprovalStatusSchema, GrantDecisionSchema }
export type {
  ApprovalStatus,
  ClientId,
  ConnectionRef,
  GrantDecision,
  GrantId
} from "@mokronos/integrations/domain"

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
  connections: Schema.Array(ExecutorConnection)
})

export const ClientsResponse = Schema.Struct({
  clients: Schema.Array(Client)
})

export const GrantsResponse = Schema.Struct({
  grants: Schema.Array(Grant)
})

export const GrantedTool = Schema.Struct({
  alias: Grant.fields.alias,
  tool: Grant.fields.tool,
  integration: Schema.String,
  decision: Grant.fields.decision,
  inputSchema: Schema.optional(Schema.Json),
  outputSchema: Schema.optional(Schema.Json)
})
export type GrantedTool = typeof GrantedTool.Type

export const GrantedToolsResponse = Schema.Struct({ tools: Schema.Array(GrantedTool) })

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
  tools: Schema.Array(ExecutorToolSummary)
})

/** The one and only time a key's plaintext exists outside the holder's hands. */
export const IssuedKey = Schema.Struct({
  id: Schema.String,
  clientId: Schema.String,
  secret: Schema.String
})
export type IssuedKey = typeof IssuedKey.Type

export const ConnectionCreated = Schema.Struct({
  connection: ExecutorConnection,
  tools: Schema.Array(ExecutorToolSummary)
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
      connection: ExecutorConnection
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

export const MaintenanceResult = Schema.Struct({
  expiredApprovals: Schema.Number,
  expiredAuditArguments: Schema.Number
})
export type MaintenanceResult = typeof MaintenanceResult.Type

export const Revoked = Schema.Struct({
  revoked: Schema.Boolean,
  cancelledApprovals: Schema.optional(Schema.Number)
})
export type Revoked = typeof Revoked.Type

export const Removed = Schema.Struct({ removed: Schema.Boolean })

/** The result of an invocation is whatever the tool returned — the gateway does
 *  not own its shape, so neither does this. */
export const InvocationResult = Schema.Json

export const decodeIntegrations = json(IntegrationsResponse)
export const decodeConnections = json(ConnectionsResponse)
export const decodeClients = json(ClientsResponse)
export const decodeGrants = json(GrantsResponse)
export const decodeGrantedTools = json(GrantedToolsResponse)
export const decodeApprovals = json(ApprovalsResponse)
export const decodeAudit = json(AuditResponse)
export const decodeKeys = json(KeysResponse)
export const decodeTools = json(ToolsResponse)
export const decodeTool = json(ExecutorTool)
export const decodeIssuedKey = json(IssuedKey)
export const decodeConnectionCreated = json(ConnectionCreated)
export const decodeOAuthSession = json(OAuthSession)
export const decodeDiscovery = json(IntegrationDiscovery)
export const decodeDrift = json(DriftResponse)
export const decodeMaintenance = json(MaintenanceResult)
export const decodeRevoked = json(Revoked)
export const decodeRemoved = json(Removed)
export const decodeClient = json(Client)
export const decodeGrant = json(Grant)
export const decodeInvocation = json(InvocationResult)
export const decodeRegistrySearch = json(IntegrationSearchResponse)
export const decodeValidation = json(IntegrationValidationReport)

/** Values arriving from a widget are strings; these turn them back into the
 * domain's own types rather than asserting them. A Select that somehow yields
 * an unknown value fails loudly here instead of silently sending nonsense to
 * the gateway. */
export const decodeGrantDecision = Schema.decodeUnknownSync(GrantDecisionSchema)
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
    subjectId: Schema.String
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

export const EmailChanged = Schema.Struct({ email: Schema.String })
export const PasswordChanged = Schema.Struct({
  updated: Schema.Literal(true),
  revokedSessions: Schema.Number
})
export const AccountDeleted = Schema.Struct({ deleted: Schema.Literal(true) })

export const decodeEmailChanged = json(EmailChanged)
export const decodePasswordChanged = json(PasswordChanged)
export const decodeAccountDeleted = json(AccountDeleted)
