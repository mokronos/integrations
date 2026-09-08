import { Schema } from "effect"

import { AuthMethod, Integration } from "./integration.ts"
import { Tool } from "./tool.ts"

export const IntegrationKind = Schema.Literals(["mcp", "openapi"])
export type IntegrationKind = typeof IntegrationKind.Type

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
  readonly slug?: string
  readonly name?: string
}

export const IntegrationNodeSource = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("tool"),
    address: Schema.String,
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
