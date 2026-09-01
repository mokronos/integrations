import { Schema } from "effect"

// --- identifiers ------------------------------------------------------------
// Nearly every primitive here is branded: configuration and client IDs are all
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

export const AccessProfileId = Schema.String.pipe(Schema.brand("AccessProfileId"))
export type AccessProfileId = typeof AccessProfileId.Type

export const ApprovalPolicyId = Schema.String.pipe(Schema.brand("ApprovalPolicyId"))
export type ApprovalPolicyId = typeof ApprovalPolicyId.Type

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

/** One connection's identity as a string, so a route can be looked up in a Map
 *  without every caller inventing its own delimiter. */
export const connectionRefKey = (connection: ConnectionRef): string =>
  [
    connection.owner,
    connectionSubject(connection) ?? "",
    connection.integration,
    connection.name
  ].join("\u0000")

/** Whether two references name the same credential. Configuration rules
 *  are matched on this, so a rule written for the work connection can never
 *  authorize a call that routes to the personal one. */
export const sameConnectionRef = (left: ConnectionRef, right: ConnectionRef): boolean =>
  connectionRefKey(left) === connectionRefKey(right)

const utf8 = new TextEncoder()

/** One part of an alias, in the only character class an alias may contain.
 *
 *  `[a-z0-9]` passes through; every other byte becomes `-` and its two hex
 *  digits. Two properties follow, and the join below depends on both: the
 *  encoding is reversible, so two different parts can never encode alike, and
 *  an encoded part can never contain `--`, because a `-` is always followed by
 *  a hex digit. UTF-8 bytes rather than code points keep the escape a fixed two
 *  characters wide for a subject identifier outside ASCII. */
const aliasPart = (value: string): string =>
  Array.from(utf8.encode(value), (byte) =>
    byte >= 0x61 && byte <= 0x7a || byte >= 0x30 && byte <= 0x39
      ? String.fromCharCode(byte)
      : `-${byte.toString(16).padStart(2, "0")}`).join("")

/** The wire protocol needs a compact name for a connection: a tool is called as
 *  `alias.tool`, and neither `/` nor `:` survives that spelling.
 *
 *  Every field of the reference is in here, joined by `--`, because the alias
 *  is the whole identity or it is a collision waiting to happen: dropping the
 *  owner tier and subject would file the tenant's Linear connection and one
 *  person's own under the same name, and `authorizeInvocation` resolves a call
 *  by finding the first profile tool whose alias matches. Since no encoded part
 *  contains `--`, the join is unambiguous and the mapping from connection to
 *  alias is injective — distinct connections cannot share an alias.
 *
 *  The common case stays readable: `org--linear--work`, and a user-tier
 *  connection reads `user--sebastian--linear--work`. */
export const aliasForConnection = (connection: ConnectionRef): Alias =>
  Alias.make([
    // The tier is already `org` or `user`, which is also what starts the alias
    // with a letter as its pattern requires.
    connection.owner,
    ...connection.owner === "user" ? [aliasPart(connection.subject)] : [],
    aliasPart(connection.integration),
    aliasPart(connection.name)
  ].join("--"))

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
  /** The tenant this client belongs to. Every access profile, approval policy, key, and audit record the
   *  client produces resolves inside this partition. */
  tenantId: TenantId,
  accessProfileId: AccessProfileId,
  approvalPolicyId: ApprovalPolicyId,
  name: Schema.String,
  /** Non-invocation authority held by this client. Tool authority is the
   *  intersection of its access profile and approval policy. */
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

// --- access profiles and approval policies ---------------------------------

export const PolicyDecision = Schema.Literals(["allow", "require_approval"])
export type PolicyDecision = typeof PolicyDecision.Type

const ReusableConfiguration = {
  tenantId: TenantId,
  name: Schema.String,
  isDefault: Schema.Boolean,
  createdAt: Schema.Date,
  updatedAt: Schema.Date
}

export const AccessProfile = Schema.Struct({
  id: AccessProfileId,
  ...ReusableConfiguration
})
export type AccessProfile = typeof AccessProfile.Type

/** One enabled tool. Connection membership is derived from this set. */
export const AccessProfileTool = Schema.Struct({
  accessProfileId: AccessProfileId,
  connection: ConnectionRef,
  tool: ToolName
})
export type AccessProfileTool = typeof AccessProfileTool.Type

export const ApprovalPolicy = Schema.Struct({
  id: ApprovalPolicyId,
  ...ReusableConfiguration
})
export type ApprovalPolicy = typeof ApprovalPolicy.Type

export const ApprovalPolicyTool = Schema.Struct({
  approvalPolicyId: ApprovalPolicyId,
  connection: ConnectionRef,
  tool: ToolName,
  decision: PolicyDecision
})
export type ApprovalPolicyTool = typeof ApprovalPolicyTool.Type

// --- authorization ----------------------------------------------------------

/** What a presented key resolves to.
 *
 * `not-authorized` deliberately covers every missing side of the intersection.
 * Distinguishing them would turn the gateway into
 * an enumeration oracle for a caller probing what else is connected. */
export const Authorization = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("authorized"),
    client: Client,
    accessProfile: AccessProfile,
    accessProfileTool: AccessProfileTool,
    approvalPolicy: ApprovalPolicy,
    approvalPolicyTool: ApprovalPolicyTool,
    /** The protocol still addresses a connection by an alias. It is derived
     * deterministically from the profile tool's connection, not stored per
     * client as authorization state. */
    alias: Alias,
    connection: ConnectionRef,
    subject: Schema.NullOr(SubjectId),
    decision: PolicyDecision
  }),
  Schema.Struct({ status: Schema.Literal("unknown-key") }),
  Schema.Struct({ status: Schema.Literal("key-revoked") }),
  Schema.Struct({ status: Schema.Literal("client-revoked") }),
  Schema.Struct({
    status: Schema.Literal("not-authorized"),
    alias: Alias,
    tool: ToolName
  })
])
export type Authorization = typeof Authorization.Type

export const describeAuthorization = (authorization: Authorization): string => {
  switch (authorization.status) {
    case "authorized":
      return `authorized ${authorization.alias}.${authorization.accessProfileTool.tool}`
    case "unknown-key":
      return "the presented API key is not recognised"
    case "key-revoked":
      return "the presented API key has been revoked"
    case "client-revoked":
      return "the client this key belongs to has been revoked"
    case "not-authorized":
      return `${authorization.alias}.${authorization.tool} is not authorized for this client`
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
 *  discharges one specific invocation rather than creating a capability.
 *
 *  One frozen call, not one per attempt: a caller that retries the same
 *  arguments through the same access profile and approval policy meets the approval it already
 *  proposed.
 *  Otherwise a step with `retry: { attempts: 3 }` asks a human three times for
 *  one decision. */
export const PendingApproval = Schema.Struct({
  id: ApprovalId,
  clientId: ClientId,
  approvalPolicyId: ApprovalPolicyId,
  accessProfileId: AccessProfileId,
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
  decision: Schema.NullOr(PolicyDecision),
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
