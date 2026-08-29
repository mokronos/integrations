import { Schema } from "effect"

// --- identifiers ------------------------------------------------------------
// Nearly every primitive here is branded: a ClientId and a GrantId are both
// strings, and confusing them would silently authorize the wrong caller.

export const TenantId = Schema.String.pipe(Schema.brand("TenantId"))
export type TenantId = typeof TenantId.Type

/** A human. Never a client — machines are delegated to, they do not hold
 *  connections. See docs/adr/0001. */
export const SubjectId = Schema.String.pipe(Schema.brand("SubjectId"))
export type SubjectId = typeof SubjectId.Type

export const ClientId = Schema.String.pipe(Schema.brand("ClientId"))
export type ClientId = typeof ClientId.Type

export const ApiKeyId = Schema.String.pipe(Schema.brand("ApiKeyId"))
export type ApiKeyId = typeof ApiKeyId.Type

export const GrantId = Schema.String.pipe(Schema.brand("GrantId"))
export type GrantId = typeof GrantId.Type

export const ApprovalId = Schema.String.pipe(Schema.brand("ApprovalId"))
export type ApprovalId = typeof ApprovalId.Type

export const AuditId = Schema.String.pipe(Schema.brand("AuditId"))
export type AuditId = typeof AuditId.Type

/** The shared vocabulary, re-exported rather than restated.
 *
 *  These four used to be defined again here, and three of them had lost their
 *  validation on the way: `Schema.brand` keys the brand on the name, so a
 *  second definition produces the *same* TypeScript type while checking
 *  something different. The gateway was minting `IntegrationSlug`s that the
 *  host's own schema would have rejected, and nothing could say so. */
import { Alias, ConnectionName, IntegrationSlug, ToolName } from "@mokronos/contracts"

export { Alias, ConnectionName, IntegrationSlug, ToolName }

/** The SHA-256 of an API key. The key itself is shown once at issue and never
 *  stored, so a leaked database yields no usable credential. */
export const ApiKeyHash = Schema.String.pipe(Schema.brand("ApiKeyHash"))
export type ApiKeyHash = typeof ApiKeyHash.Type

/** The SHA-256 of a session token. Like an API key hash, the token itself is
 *  never stored — only the human's cookie holds it. */
export const SessionTokenHash = Schema.String.pipe(Schema.brand("SessionTokenHash"))
export type SessionTokenHash = typeof SessionTokenHash.Type

/** Hashes of short-lived browser handoff secrets. The plaintext is held only
 * by the browser or CLI that started the sign-in. */
export const LoginHandoffHash = Schema.String.pipe(Schema.brand("LoginHandoffHash"))
export type LoginHandoffHash = typeof LoginHandoffHash.Type

// --- tenants ----------------------------------------------------------------

/** The well-known tenant every pre-existing deployment belongs to. A gateway
 *  that predates tenancy keeps working unchanged: its rows are backfilled here
 *  rather than rewritten into some generated partition. */
export const defaultTenantId = TenantId.make("default")

/** The isolation partition itself. An opaque identifier plus a display name —
 *  nothing else. Everything else the gateway stores hangs off one. */
export const Tenant = Schema.Struct({
  id: TenantId,
  name: Schema.String,
  createdAt: Schema.Date
})
export type Tenant = typeof Tenant.Type

/** A human identity within a tenant. Still opaque — authentication details
 *  live in their own tables (logins, sessions), never on the subject. */
export const Subject = Schema.Struct({
  id: SubjectId,
  tenantId: TenantId,
  createdAt: Schema.Date
})
export type Subject = typeof Subject.Type

/** The credential a human signs in with. Held beside the subject rather than on
 *  it: the subject remains an opaque identity, and a login can be deleted
 *  without touching anything the subject is referenced by. */
export const Login = Schema.Struct({
  subjectId: SubjectId,
  tenantId: TenantId,
  email: Schema.String,
  createdAt: Schema.Date
})
export type Login = typeof Login.Type

export const AuthSession = Schema.Struct({
  tokenHash: SessionTokenHash,
  tenantId: TenantId,
  subjectId: SubjectId,
  /** Carried for display and audit; never used for lookup. */
  email: Schema.String,
  createdAt: Schema.Date,
  expiresAt: Schema.Date
})
export type AuthSession = typeof AuthSession.Type

/** Human authentication through an external identity system. This is not an
 * integration connection: a Google identity signs into the control plane; a
 * Google integration authorization lets a tool call Google APIs. */
export const IdentityProvider = Schema.Literal("google")
export type IdentityProvider = typeof IdentityProvider.Type

export const ExternalIdentity = Schema.Struct({
  provider: IdentityProvider,
  providerSubject: Schema.String,
  tenantId: TenantId,
  subjectId: SubjectId,
  email: Schema.String,
  createdAt: Schema.Date
})
export type ExternalIdentity = typeof ExternalIdentity.Type

export const LoginHandoff = Schema.Struct({
  requestHash: LoginHandoffHash,
  subjectId: Schema.NullOr(SubjectId),
  tenantId: Schema.NullOr(TenantId),
  email: Schema.NullOr(Schema.String),
  createdAt: Schema.Date,
  expiresAt: Schema.Date,
  collectedAt: Schema.NullOr(Schema.Date)
})
export type LoginHandoff = typeof LoginHandoff.Type

// --- connections ------------------------------------------------------------

/** Which partition a connection is filed under. Not an entity. */
export const OwnerTier = Schema.Literals(["org", "user"])
export type OwnerTier = typeof OwnerTier.Type

/** Identifies one connection. Org-tier connections belong to the whole tenant
 *  and carry no subject; user-tier connections always name the human whose
 *  authorization they are. The union makes the impossible pair — a user-tier
 *  connection with nobody behind it — unrepresentable. */
export const ConnectionRef = Schema.Union([
  Schema.Struct({
    owner: Schema.Literal("org"),
    integration: IntegrationSlug,
    name: ConnectionName
  }),
  Schema.Struct({
    owner: Schema.Literal("user"),
    subject: SubjectId,
    integration: IntegrationSlug,
    name: ConnectionName
  })
])
export type ConnectionRef = typeof ConnectionRef.Type

/** The human a call acts for, read off the connection rather than the token. */
export const connectionSubject = (connection: ConnectionRef): SubjectId | undefined =>
  connection.owner === "user" ? connection.subject : undefined

// --- clients and keys -------------------------------------------------------

export const ClientCapability = Schema.Literals([
  "provision_connections",
  "administer_gateway"
])
export type ClientCapability = typeof ClientCapability.Type

/** How a client learns that one of its invocations needs a human. Delivery
 * announces the pending approval; it never carries authority to decide it.
 * Approval links still require a signed-in human at the dashboard. */
export const ApprovalDelivery = Schema.Struct({
  returnLink: Schema.Boolean,
  webhooks: Schema.Array(
    Schema.String.check(Schema.isPattern(/^https?:\/\/[^\s]+$/))
  ).check(Schema.isMaxLength(10))
})
export type ApprovalDelivery = typeof ApprovalDelivery.Type

export const defaultApprovalDelivery: ApprovalDelivery = {
  returnLink: true,
  webhooks: []
}

export const Client = Schema.Struct({
  id: ClientId,
  /** The tenant this client belongs to. Every grant, key, and audit record the
   *  client produces resolves inside this partition. */
  tenantId: TenantId,
  name: Schema.String,
  /** Non-invocation authority held by this client. Tool authority remains in
   *  grants; these capabilities only govern provisioning and administration. */
  capabilities: Schema.Array(ClientCapability),
  approvalDelivery: ApprovalDelivery,
  createdAt: Schema.Date,
  revokedAt: Schema.NullOr(Schema.Date)
})
export type Client = typeof Client.Type

export const clientHasCapability = (
  client: Client,
  capability: ClientCapability
): boolean => client.capabilities.includes(capability)

export const ApiKey = Schema.Struct({
  id: ApiKeyId,
  clientId: ClientId,
  hash: ApiKeyHash,
  createdAt: Schema.Date,
  lastUsedAt: Schema.NullOr(Schema.Date),
  revokedAt: Schema.NullOr(Schema.Date)
})
export type ApiKey = typeof ApiKey.Type

// --- grants -----------------------------------------------------------------

/** There is no `block`. Denial is the absence of a grant, and discovery is
 *  grant-scoped, so an ungranted tool is invisible rather than
 *  visible-then-failing. See docs/adr/0002. */
export const GrantDecision = Schema.Literals(["allow", "require_approval"])
export type GrantDecision = typeof GrantDecision.Type

/** One delegation: this client may invoke this tool through this connection.
 *  Explicit per tool, never a pattern — a vendor shipping a new tool must not
 *  land inside an existing grant. */
export const Grant = Schema.Struct({
  id: GrantId,
  clientId: ClientId,
  alias: Alias,
  tool: ToolName,
  connection: ConnectionRef,
  decision: GrantDecision,
  createdAt: Schema.Date,
  revokedAt: Schema.NullOr(Schema.Date)
})
export type Grant = typeof Grant.Type

// --- authorization ----------------------------------------------------------

/** What a presented key resolves to.
 *
 * `not-granted` deliberately covers both "no such alias" and "alias exists but
 * that tool was never granted". Distinguishing them would turn the gateway into
 * an enumeration oracle for a caller probing what else is connected. */
export const Authorization = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("authorized"),
    client: Client,
    grant: Grant,
    connection: ConnectionRef,
    subject: Schema.NullOr(SubjectId)
  }),
  Schema.Struct({ status: Schema.Literal("unknown-key") }),
  Schema.Struct({ status: Schema.Literal("key-revoked") }),
  Schema.Struct({ status: Schema.Literal("client-revoked") }),
  Schema.Struct({
    status: Schema.Literal("not-granted"),
    alias: Alias,
    tool: ToolName
  })
])
export type Authorization = typeof Authorization.Type

export const describeAuthorization = (authorization: Authorization): string => {
  switch (authorization.status) {
    case "authorized":
      return `authorized ${authorization.grant.alias}.${authorization.grant.tool}`
    case "unknown-key":
      return "the presented API key is not recognised"
    case "key-revoked":
      return "the presented API key has been revoked"
    case "client-revoked":
      return "the client this key belongs to has been revoked"
    case "not-granted":
      return `${authorization.alias}.${authorization.tool} is not granted to this client`
  }
}

// --- approvals --------------------------------------------------------------

export const ApprovalStatus = Schema.Literals([
  "pending",
  "approved",
  "denied",
  "expired"
])
export type ApprovalStatus = typeof ApprovalStatus.Type

/** An invocation frozen awaiting a human. The arguments are captured at propose
 *  time and the gateway performs the call itself on approval, so approving
 *  discharges one specific invocation rather than granting a capability.
 *
 *  One frozen call, not one per attempt: a caller that retries the same
 *  arguments through the same grant meets the approval it already proposed.
 *  Otherwise a step with `retry: { attempts: 3 }` asks a human three times for
 *  one decision. */
export const PendingApproval = Schema.Struct({
  id: ApprovalId,
  clientId: ClientId,
  grantId: GrantId,
  alias: Alias,
  tool: ToolName,
  arguments: Schema.Json,
  status: ApprovalStatus,
  createdAt: Schema.Date,
  expiresAt: Schema.Date,
  decidedAt: Schema.NullOr(Schema.Date),
  decidedBy: Schema.NullOr(Schema.String),
  result: Schema.NullOr(Schema.Json),
  error: Schema.NullOr(Schema.String),
  /** When the decision was handed back to the caller. Delivery happens once:
   *  until it does, retries keep meeting this approval; after it, an identical
   *  call is a new request that needs its own decision. */
  collectedAt: Schema.NullOr(Schema.Date)
})
export type PendingApproval = typeof PendingApproval.Type

/** The identity of a frozen call's arguments.
 *
 * Key order is an artefact of how a caller built its JSON, not part of what it
 * asked for, so it is normalised away before two attempts are compared. */
export const canonicalArguments = (value: Schema.Json): string =>
  JSON.stringify(canonicalise(value))

/** Derived from the schema so the guard narrows to a JSON object rather than to
 *  a bag of `unknown`, which would lose the value contract on the way in. */
const isJsonObject = Schema.is(Schema.Record(Schema.String, Schema.Json))

const canonicalise = (value: Schema.Json): Schema.Json => {
  if (Array.isArray(value)) return value.map(canonicalise)
  if (isJsonObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        // Codepoint order rather than locale order: this string is compared
        // against one written by another process, possibly on another machine.
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, nested]) => [key, canonicalise(nested)])
    )
  }
  return value
}

// --- audit ------------------------------------------------------------------

export const AuditOutcome = Schema.Literals([
  "succeeded",
  "failed",
  "denied",
  "pending"
])
export type AuditOutcome = typeof AuditOutcome.Type

/** The permanent half of the audit trail: who invoked what, for whom, and what
 *  the gateway decided. Small, not sensitive, and kept indefinitely. */
export const AuditRecord = Schema.Struct({
  id: AuditId,
  clientId: Schema.NullOr(ClientId),
  alias: Schema.NullOr(Alias),
  tool: Schema.NullOr(ToolName),
  connection: Schema.NullOr(ConnectionRef),
  subject: Schema.NullOr(SubjectId),
  decision: Schema.NullOr(GrantDecision),
  outcome: AuditOutcome,
  message: Schema.NullOr(Schema.String),
  createdAt: Schema.Date
})
export type AuditRecord = typeof AuditRecord.Type

/** The expiring half. Arguments are where the PII lives and their forensic
 *  value decays within days, so they age out while the record above does not. */
export const AuditArguments = Schema.Struct({
  auditId: AuditId,
  arguments: Schema.Json,
  expiresAt: Schema.Date
})
export type AuditArguments = typeof AuditArguments.Type

// --- catalog drift ----------------------------------------------------------

/** What a tool looked like when it was last synced, so a vendor renaming or
 *  reshaping it is reported rather than discovered at 3am. */
export const ToolSnapshot = Schema.Struct({
  integration: IntegrationSlug,
  connection: ConnectionName,
  tool: ToolName,
  inputSchema: Schema.NullOr(Schema.Json),
  outputSchema: Schema.NullOr(Schema.Json),
  syncedAt: Schema.Date
})
export type ToolSnapshot = typeof ToolSnapshot.Type

export const DriftKind = Schema.Literals(["added", "removed", "changed"])
export type DriftKind = typeof DriftKind.Type

export const DriftEntry = Schema.Struct({
  kind: DriftKind,
  integration: IntegrationSlug,
  connection: ConnectionName,
  tool: ToolName
})
export type DriftEntry = typeof DriftEntry.Type
