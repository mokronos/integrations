import { Schema } from "effect"
import {
  ApprovalStatus as ApprovalStatusSchema,
  AuditRecord,
  Client,
  DriftEntry,
  Grant,
  GrantDecision as GrantDecisionSchema,
  PendingApproval
} from "@mokronos/integrations/domain"
import { IntegrationDiscovery } from "@mokronos/wfkit-executor/integration-model"
import {
  ExecutorConnection,
  ExecutorTool,
  ExecutorToolSummary,
  IntegrationOverview
} from "@mokronos/wfkit-executor/schemas"

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
  Client,
  DriftEntry,
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
  integrations: Schema.Array(IntegrationOverview)
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

export const ApprovalsResponse = Schema.Struct({
  approvals: Schema.Array(PendingApproval)
})

export const AuditResponse = Schema.Struct({
  records: Schema.Array(AuditRecord)
})

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
  checkedAt: Schema.Date
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
export const decodeApprovals = json(ApprovalsResponse)
export const decodeAudit = json(AuditResponse)
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

/** Values arriving from a widget are strings; these turn them back into the
 * domain's own types rather than asserting them. A Select that somehow yields
 * an unknown value fails loudly here instead of silently sending nonsense to
 * the gateway. */
export const decodeGrantDecision = Schema.decodeUnknownSync(GrantDecisionSchema)
export const decodeApprovalFilter = Schema.decodeUnknownSync(
  Schema.Union([ApprovalStatusSchema, Schema.Literal("all")])
)

/** `approve` performs the call, so it answers with both the settled approval
 *  and what the invocation did. */
export const ApprovalDecided = Schema.Struct({
  approval: Schema.NullOr(PendingApproval),
  outcome: Schema.optional(Schema.Json)
})
export const decodeApprovalDecided = json(ApprovalDecided)
