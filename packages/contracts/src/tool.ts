import { Schema } from "effect"
import { ToolAddress } from "./address.ts"
import { ConnectionName, IntegrationSlug, OwnerTier, ToolName } from "./vocabulary.ts"

export const ToolSummary = Schema.Struct({
  address: ToolAddress,
  name: ToolName,
  description: Schema.String,
  integration: IntegrationSlug,
  owner: OwnerTier,
  connection: ConnectionName,
  defaultDecision: Schema.Literals(["allow", "require_approval"])
})
export type ToolSummary = typeof ToolSummary.Type

export const Tool = Schema.Struct({
  ...ToolSummary.fields,
  inputSchema: Schema.optional(Schema.Json),
  outputSchema: Schema.optional(Schema.Json),
  schemaDefinitions: Schema.optional(Schema.Record(Schema.String, Schema.Json))
})
export type Tool = typeof Tool.Type
