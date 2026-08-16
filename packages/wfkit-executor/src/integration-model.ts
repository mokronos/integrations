import { Schema } from "effect"
import {
  ExecutorAuthMethod,
  ExecutorDetection,
  ExecutorIntegration,
  ExecutorMcpProbe,
  ExecutorOpenApiPreview,
  ExecutorTool
} from "./schemas.ts"

export const IntegrationKind = Schema.Literals(["mcp", "openapi"])
export type IntegrationKind = typeof IntegrationKind.Type

const McpDetection = Schema.Struct({
  ...ExecutorDetection.fields,
  kind: Schema.Literal("mcp")
})

const OpenApiDetection = Schema.Struct({
  ...ExecutorDetection.fields,
  kind: Schema.Literal("openapi")
})

/** A read-only description of an endpoint. Inspection never installs catalog
 * state, creates credentials, or opens a connection. */
export const IntegrationInspection = Schema.Union([
  Schema.Struct({
    url: Schema.String,
    detection: McpDetection,
    probe: ExecutorMcpProbe
  }),
  Schema.Struct({
    url: Schema.String,
    detection: OpenApiDetection,
    preview: ExecutorOpenApiPreview
  })
])
export type IntegrationInspection = typeof IntegrationInspection.Type

const DiscoveryFields = {
  integration: ExecutorIntegration,
  requiresAuthentication: Schema.Boolean,
  authMethods: Schema.Array(ExecutorAuthMethod),
  tools: Schema.Array(ExecutorTool)
}

export const IntegrationDiscovery = Schema.Union([
  Schema.Struct({
    url: Schema.String,
    detection: McpDetection,
    probe: ExecutorMcpProbe,
    ...DiscoveryFields
  }),
  Schema.Struct({
    url: Schema.String,
    detection: OpenApiDetection,
    preview: ExecutorOpenApiPreview,
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
    kind: Schema.Literal("executor"),
    address: Schema.String,
    // A node carrying both forms is ambiguous — the two can disagree about
    // which tool is meant — so it is rejected rather than silently resolved by
    // whichever variant matched first.
    integration: Schema.optionalKey(Schema.Never),
    tool: Schema.optionalKey(Schema.Never)
  }),
  Schema.Struct({
    kind: Schema.Literal("executor"),
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
