import { Schema } from "effect"
import { ToolAddress } from "./address.ts"
import { ConnectionName, IntegrationSlug, ConnectionOwner, ToolName } from "./vocabulary.ts"

export const ToolSummary = Schema.Struct({
  address: ToolAddress,
  name: ToolName,
  description: Schema.String,
  integration: IntegrationSlug,
  owner: ConnectionOwner,
  connection: ConnectionName,
  defaultDecision: Schema.Literals(["allow", "require_approval"]),
  /** Only reads; the default decision lets it run without asking. */
  readOnly: Schema.Boolean,
  /** May destroy or overwrite what is there, rather than only add to it. Assumed when the source does not say. */
  destructive: Schema.Boolean,
  /** Calling it again with the same arguments has no further effect. Not assumed when the source does not say. */
  idempotent: Schema.Boolean
})
export type ToolSummary = typeof ToolSummary.Type

export const Tool = Schema.Struct({
  ...ToolSummary.fields,
  inputSchema: Schema.optional(Schema.Json),
  outputSchema: Schema.optional(Schema.Json),
  schemaDefinitions: Schema.optional(Schema.Record(Schema.String, Schema.Json))
})
export type Tool = typeof Tool.Type
