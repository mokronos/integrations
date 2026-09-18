import { Schema } from "effect"
import {
  ConnectionName,
  HttpMethod,
  IntegrationSlug,
  ConnectionOwner,
  ParameterLocation,
  ToolAddress
} from "@mokronos/integrations-contracts"
export { HttpMethod, ParameterLocation } from "@mokronos/integrations-contracts"

export const McpCall = Schema.Struct({ kind: Schema.Literal("mcp"), tool: Schema.String })
export type McpCall = typeof McpCall.Type

export const CallParameter = Schema.Struct({
  name: Schema.String,
  location: ParameterLocation,
  style: Schema.String,
  explode: Schema.Boolean,
  required: Schema.Boolean
})
export type CallParameter = typeof CallParameter.Type

export const HttpCall = Schema.Struct({
  kind: Schema.Literal("http"),
  method: HttpMethod,
  path: Schema.String,
  parameters: Schema.Array(CallParameter),
  locations: Schema.Record(Schema.String, ParameterLocation),
  contentType: Schema.optional(Schema.String),
  bodyProperty: Schema.optional(Schema.String),
  /** Overrides the integration's base URL when the document gave this operation one. */
  server: Schema.optional(Schema.String)
})
export type HttpCall = typeof HttpCall.Type

export const ToolCall = Schema.Union([McpCall, HttpCall])
export type ToolCall = typeof ToolCall.Type

export const Tool = Schema.Struct({
  address: ToolAddress,
  owner: ConnectionOwner,
  integration: IntegrationSlug,
  connection: ConnectionName,
  name: Schema.String,
  description: Schema.String,
  readOnly: Schema.Boolean,
  inputSchema: Schema.optional(Schema.Json),
  outputSchema: Schema.optional(Schema.Json),
  call: ToolCall,
  capturedAt: Schema.Number
})
export type Tool = typeof Tool.Type
