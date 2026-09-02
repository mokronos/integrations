import { Option, Schema } from "effect"
import { ConnectionName, IntegrationSlug, OwnerTier, ToolName } from "./vocabulary.ts"

/** How a tool and a connection are addressed.
 *
 *  Addressing is a contract, not an implementation detail: the gateway builds an
 *  address from a binding, the host resolves one to a call, and a client reads one
 *  off a listing. All three have to agree, so the format lives here with the
 *  functions that build and parse it. */

export const ToolAddress = Schema.String
  .check(Schema.isPattern(/^tools\.[^.]+\.(org|user)\.[^.]+\..+$/))
  .pipe(Schema.brand("ToolAddress"))
export type ToolAddress = typeof ToolAddress.Type

/** `tools.<integration>.<owner>.<connection>` — a connection's address.
 *
 *  Deliberately the exact prefix of every tool address it carries, so a reader
 *  who has one can see which connection a tool runs under. */
export const ConnectionAddress = Schema.String
  .check(Schema.isPattern(/^tools\.[^.]+\.(org|user)\.[^.]+$/))
  .pipe(Schema.brand("ConnectionAddress"))
export type ConnectionAddress = typeof ConnectionAddress.Type

export interface ParsedToolAddress {
  readonly integration: IntegrationSlug
  readonly owner: OwnerTier
  readonly connection: ConnectionName
  readonly tool: ToolName
}

const decodeParts = Schema.decodeUnknownOption(Schema.Struct({
  integration: IntegrationSlug,
  owner: OwnerTier,
  connection: ConnectionName,
  tool: ToolName
}))

/** Parses a callable address, or `None` when it is not a well-formed
 *  `tools.<integration>.<owner>.<connection>.<tool>`.
 *
 *  The four leading segments are slug-like and never contain a `.`; the tool
 *  segment is the entire remainder, so a dotted tool name round-trips. */
export const parseToolAddress = (address: string): Option.Option<ParsedToolAddress> => {
  const segments = address.split(".")
  const [prefix, integration, owner, connection] = segments
  if (prefix !== "tools" || segments.length < 5) return Option.none()
  if (integration === undefined || owner === undefined || connection === undefined) {
    return Option.none()
  }
  return decodeParts({
    integration,
    owner,
    connection,
    tool: segments.slice(4).join(".")
  })
}

export const toolAddress = (parts: ParsedToolAddress): ToolAddress =>
  ToolAddress.make(
    `tools.${parts.integration}.${parts.owner}.${parts.connection}.${parts.tool}`
  )

export const connectionAddress = (parts: {
  readonly owner: OwnerTier
  readonly integration: IntegrationSlug
  readonly connection: ConnectionName
}): ConnectionAddress =>
  ConnectionAddress.make(
    `tools.${parts.integration}.${parts.owner}.${parts.connection}`
  )

/** Second-level labels that belong to a public suffix rather than to a name.
 *
 *  The Public Suffix List is the exhaustive answer and a data file that would
 *  have to ship and stay current. What this has to be right about is narrower:
 *  the label it helps derive is a default offered at discovery, which the
 *  person discovering can overrule, and nothing depends on it afterwards. */
const compoundSuffixes = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk",
  "com.au", "net.au", "org.au",
  "co.nz", "co.za", "co.il", "co.in", "co.kr",
  "co.jp", "or.jp", "ne.jp",
  "com.br", "com.cn", "com.mx", "com.tr", "com.sg", "com.hk", "com.tw"
])

/** Labels that name a service's front door rather than the service. Kept short
 *  on purpose: every addition is a word no vendor can be called. */
const frontDoorLabels = new Set(["mcp", "api", "www", "tools"])

/** The label in a hostname that names the service.
 *
 *  A slug taken from a whole hostname reads like `mcp_linear_app`, which names
 *  a URL rather than a vendor and then turns up in every alias an agent writes.
 *  The public suffix says nothing about who the service is, and neither does a
 *  front-door label, so both come off; the leftmost of what remains is the most
 *  specific thing the host says about itself — `mcp.linear.app` is Linear, and
 *  `gmailmcp.googleapis.com` is gmailmcp rather than googleapis.
 *
 *  A host with nothing to strip — an address literal, `localhost`, a bare label
 *  — comes back unchanged, because inventing a name for it would be worse than
 *  saying what it is. */
export const serviceLabel = (hostname: string): string => {
  const host = hostname.toLowerCase().replace(/\.$/, "")
  // An address literal has octets, not labels, and none of them names anything.
  if (/^[\d.]+$/.test(host) || host.includes(":")) return host
  const labels = host.split(".")
  if (labels.length < 2) return host
  const suffixLength = compoundSuffixes.has(labels.slice(-2).join(".")) ? 2 : 1
  const named = labels.slice(0, -suffixLength)
  const specific = named.filter((label) => !frontDoorLabels.has(label))
  // Every label was a front door: `api.example.com` has nothing more specific
  // on offer than the front door itself.
  return specific[0] ?? named[0] ?? host
}

/** The same label as something to show a person. Capitalising a single word is
 *  reversible and it is what someone would have typed; anything cleverer would
 *  be inventing a brand. The name is editable afterwards either way. */
export const serviceName = (hostname: string): string => {
  const label = serviceLabel(hostname)
  return label.charAt(0).toUpperCase() + label.slice(1)
}

/** Derives an addressable slug from a human name or a hostname. Vendors rarely
 *  supply one, and the catalog needs one for every integration. */
export const slugify = (value: string): Option.Option<IntegrationSlug> =>
  Schema.decodeUnknownOption(IntegrationSlug)(
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
  )
