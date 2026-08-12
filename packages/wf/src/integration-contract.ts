import { Schema } from "effect"

export const IntegrationOwner = Schema.Literals(["org", "user"])
export type IntegrationOwner = typeof IntegrationOwner.Type

/** A portable tool requirement. Connection names and resolved tool addresses
 * belong to the integration host and never enter workflow source. */
export const PortableIntegrationSource = Schema.Struct({
  kind: Schema.Literal("executor"),
  integration: Schema.String,
  tool: Schema.String,
  owner: Schema.optional(IntegrationOwner),
  address: Schema.optionalKey(Schema.Never)
})
export type PortableIntegrationSource = typeof PortableIntegrationSource.Type

/** Compatibility for source snapshots authored before portable requirements.
 * New workflows should never persist this connection-bound form. */
export const LegacyIntegrationSource = Schema.Struct({
  kind: Schema.Literal("executor"),
  address: Schema.String.pipe(
    Schema.refine((value): value is string => /^tools\.[^.]+\.(org|user)\.[^.]+\..+$/.test(value))
  ),
  integration: Schema.optionalKey(Schema.Never),
  tool: Schema.optionalKey(Schema.Never),
  owner: Schema.optionalKey(Schema.Never)
})
export type LegacyIntegrationSource = typeof LegacyIntegrationSource.Type

export const IntegrationSource = Schema.Union([
  PortableIntegrationSource,
  LegacyIntegrationSource
])
export type IntegrationSource = typeof IntegrationSource.Type

export const formatIntegrationSource = (source: IntegrationSource): string =>
  "address" in source
    ? source.address
    : source.owner === undefined
    ? `${source.integration}.${source.tool}`
    : `${source.integration}.${source.owner}.${source.tool}`

/** Collision-free identity for durable step names and requirement deduplication. */
export const integrationSourceKey = (source: IntegrationSource): string =>
  "address" in source
    ? `executor-address:${encodeURIComponent(source.address)}`
    : `executor:${encodeURIComponent(source.integration)}:${source.owner ?? "_"}:${encodeURIComponent(source.tool)}`

type JsonValue = typeof Schema.Json.Type

/** The only runtime capability workflow execution needs from an integration
 * host. Resolution, authentication, transport, and credentials stay behind it. */
export interface IntegrationInvoker {
  readonly invoke: (source: IntegrationSource, input: JsonValue) => Promise<JsonValue>
}
