import { Option, Schema } from "effect"
import { ConnectionName, IntegrationSlug, OwnerTier, ToolName } from "./vocabulary.ts"

export const ToolAddress = Schema.String
  .check(Schema.isPattern(/^tools\.[^.]+\.(org|user)\.[^.]+\..+$/))
  .pipe(Schema.brand("ToolAddress"))
export type ToolAddress = typeof ToolAddress.Type

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

const compoundSuffixes = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk",
  "com.au", "net.au", "org.au",
  "co.nz", "co.za", "co.il", "co.in", "co.kr",
  "co.jp", "or.jp", "ne.jp",
  "com.br", "com.cn", "com.mx", "com.tr", "com.sg", "com.hk", "com.tw"
])

const frontDoorLabels = new Set(["mcp", "api", "www", "tools"])

export const serviceLabel = (hostname: string): string => {
  const host = hostname.toLowerCase().replace(/\.$/, "")
  if (/^[\d.]+$/.test(host) || host.includes(":")) return host
  const labels = host.split(".")
  if (labels.length < 2) return host
  const suffixLength = compoundSuffixes.has(labels.slice(-2).join(".")) ? 2 : 1
  const named = labels.slice(0, -suffixLength)
  const specific = named.filter((label) => !frontDoorLabels.has(label))
  return specific[0] ?? named[0] ?? host
}

export const serviceName = (hostname: string): string => {
  const label = serviceLabel(hostname)
  return label.charAt(0).toUpperCase() + label.slice(1)
}

export const slugify = (value: string): Option.Option<IntegrationSlug> =>
  Schema.decodeUnknownOption(IntegrationSlug)(
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
  )
