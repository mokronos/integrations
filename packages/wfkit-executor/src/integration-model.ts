import { Schema } from "effect"
import {
  ExecutorAuthMethod,
  ExecutorDetection,
  ExecutorIntegration,
  ExecutorMcpProbe,
  ExecutorOpenApiPreview,
  ExecutorTool,
  ExecutorToolAddress
} from "./schemas.ts"

export const IntegrationKind = Schema.Literals(["mcp", "openapi"])
export type IntegrationKind = typeof IntegrationKind.Type

export const IntegrationDiscovery = Schema.Struct({
  url: Schema.String,
  detection: ExecutorDetection,
  probe: Schema.optional(ExecutorMcpProbe),
  preview: Schema.optional(ExecutorOpenApiPreview),
  integration: ExecutorIntegration,
  requiresAuthentication: Schema.Boolean,
  authMethods: Schema.Array(ExecutorAuthMethod),
  tools: Schema.Array(ExecutorTool)
})
export type IntegrationDiscovery = typeof IntegrationDiscovery.Type

export interface DiscoverIntegrationsOptions {
  readonly connection?: string
}

export const IntegrationNodeConfig = Schema.Struct({
  source: Schema.Struct({
    kind: Schema.Literal("executor"),
    address: ExecutorToolAddress
  })
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
