import { Schema } from "effect"

/** Discovery and validation contracts: what inspecting an endpoint returns, and
 *  what `integrations validate` accepts. */
import { AuthMethod, EndpointDetection, Integration, McpProbe, OpenApiPreview } from "./integration.ts"
import { Tool } from "./tool.ts"

export const IntegrationKind = Schema.Literals(["mcp", "openapi"])
export type IntegrationKind = typeof IntegrationKind.Type

const McpDetection = Schema.Struct({
  ...EndpointDetection.fields,
  kind: Schema.Literal("mcp")
})

const OpenApiDetection = Schema.Struct({
  ...EndpointDetection.fields,
  kind: Schema.Literal("openapi")
})

/** A read-only description of an endpoint. Inspection never installs catalog
 * state, creates credentials, or opens a connection. */
export const IntegrationInspection = Schema.Union([
  Schema.Struct({
    url: Schema.String,
    detection: McpDetection,
    probe: McpProbe
  }),
  Schema.Struct({
    url: Schema.String,
    detection: OpenApiDetection,
    preview: OpenApiPreview
  })
])
export type IntegrationInspection = typeof IntegrationInspection.Type

const DiscoveryFields = {
  integration: Integration,
  requiresAuthentication: Schema.Boolean,
  authMethods: Schema.Array(AuthMethod),
  tools: Schema.Array(Tool)
}

export const IntegrationDiscovery = Schema.Union([
  Schema.Struct({
    url: Schema.String,
    detection: McpDetection,
    probe: McpProbe,
    ...DiscoveryFields
  }),
  Schema.Struct({
    url: Schema.String,
    detection: OpenApiDetection,
    preview: OpenApiPreview,
    ...DiscoveryFields
  })
])
export type IntegrationDiscovery = typeof IntegrationDiscovery.Type

export interface DiscoverIntegrationsOptions {
  readonly connection?: string
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
 * the gateway can resolve, because only the gateway holds the grant that says
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
