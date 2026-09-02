import { Schema } from "effect"

/** Discovery and validation contracts: what classifying an endpoint returns,
 *  and what `integrations validate` accepts. */
import { AuthMethod, Integration } from "./integration.ts"
import { Tool } from "./tool.ts"

export const IntegrationKind = Schema.Literals(["mcp", "openapi"])
export type IntegrationKind = typeof IntegrationKind.Type

/** What a URL turned out to be. Classification is a yes or a no: an endpoint
 *  that is neither kind is an error, not a hedged answer. */
export const EndpointClassification = Schema.Struct({
  kind: IntegrationKind,
  endpoint: Schema.String,
  name: Schema.String,
  slug: Schema.String
})
export type EndpointClassification = typeof EndpointClassification.Type

export const IntegrationDiscovery = Schema.Struct({
  url: Schema.String,
  classification: EndpointClassification,
  integration: Integration,
  requiresAuthentication: Schema.Boolean,
  authMethods: Schema.Array(AuthMethod),
  tools: Schema.Array(Tool)
})
export type IntegrationDiscovery = typeof IntegrationDiscovery.Type

export interface DiscoverIntegrationsOptions {
  readonly connection?: string
  /** What to call it, when the derived name is not what a person would say.
   *
   *  `slug` is offered here and nowhere else. It is the identity — every tool
   *  address, every alias, and the key each sealed credential is filed under —
   *  so discovery is the one moment at which choosing it costs nothing,
   *  because nothing refers to it yet. */
  readonly slug?: string
  readonly name?: string
}

/**
 * What `integrations validate` accepts. Two forms, because the two surfaces
 * speak different dialects on purpose:
 *
 * - `address` — a fully-resolved `tools.…` address, the currency of the
 *   discovery commands: you have just listed a connection's tools and want to
 *   check one of them.
 * - `integration` + `tool` — no connection named, so validating it answers
 *   "does this tool exist anywhere here?" rather than "does this exact row
 *   exist?".
 *
 * Neither is the form a workflow authors. A workflow names an alias, which only
 * the gateway can resolve, because only the gateway holds the binding that says
 * which connection the alias means.
 */
export const IntegrationNodeSource = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("tool"),
    address: Schema.String,
    // A node carrying both forms is ambiguous — the two can disagree about
    // which tool is meant — so it is rejected rather than silently resolved by
    // whichever variant matched first.
    integration: Schema.optionalKey(Schema.Never),
    tool: Schema.optionalKey(Schema.Never)
  }),
  Schema.Struct({
    kind: Schema.Literal("tool"),
    integration: Schema.String,
    tool: Schema.String,
    address: Schema.optionalKey(Schema.Never)
  })
])
export type IntegrationNodeSource = typeof IntegrationNodeSource.Type

export const IntegrationNodeConfig = Schema.Struct({
  source: IntegrationNodeSource
})
export type IntegrationNodeConfig = typeof IntegrationNodeConfig.Type

export const IntegrationValidationFinding = Schema.Struct({
  severity: Schema.Literals(["error", "warning", "info"]),
  check: Schema.String,
  message: Schema.String
})
export type IntegrationValidationFinding = typeof IntegrationValidationFinding.Type

export const IntegrationValidationReport = Schema.Struct({
  ok: Schema.Boolean,
  findings: Schema.Array(IntegrationValidationFinding)
})
export type IntegrationValidationReport = typeof IntegrationValidationReport.Type
