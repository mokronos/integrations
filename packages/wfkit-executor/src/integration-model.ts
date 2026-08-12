import { Schema } from "effect"
import {
  ExecutorAuthMethod,
  ExecutorDetection,
  ExecutorIntegration,
  ExecutorMcpProbe,
  ExecutorOpenApiPreview,
  ExecutorTool
} from "./schemas.ts"
import { IntegrationSource } from "@mokronos/wfkit/integrations"

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
 * What `wf i validate` accepts. Two forms, because the two surfaces speak
 * different dialects on purpose:
 *
 * - `address` — a fully-resolved `tools.…` address. Still the currency of the
 *   discovery commands, where you have just listed a specific connection's tools
 *   and want to check one of them.
 * - `integration` + `tool` (+ optional `owner`) — the portable reference a
 *   workflow actually authors. Carries no connection, so validating it answers
 *   "would this resolve here?" rather than "does this exact row exist?".
 */
export const IntegrationNodeSource = IntegrationSource
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
