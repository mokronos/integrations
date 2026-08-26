import { Option, Schema } from "effect"
import { ConnectionName, IntegrationSlug, OwnerTier, ToolName } from "./vocabulary.ts"

/** How a tool and a connection are addressed.
 *
 *  Addressing is a contract, not an implementation detail: the gateway builds an
 *  address from a grant, the host resolves one to a call, and a client reads one
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

/** Derives an addressable slug from a human name or a hostname. Vendors rarely
 *  supply one, and the catalog needs one for every integration. */
export const slugify = (value: string): Option.Option<IntegrationSlug> =>
  Schema.decodeUnknownOption(IntegrationSlug)(
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
  )
