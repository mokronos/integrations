import { Schema } from "effect"
import { Alias, ConnectionRef, ToolDecision } from "@integragents/contracts"

export const Json = Schema.Json

export const EffectiveTool = Schema.Struct({
  alias: Alias,
  tool: Schema.String,
  connection: ConnectionRef,
  decision: ToolDecision,
  delegated: Schema.Boolean,
  readOnly: Schema.optional(Schema.Boolean),
  destructive: Schema.optional(Schema.Boolean),
  idempotent: Schema.optional(Schema.Boolean),
  description: Schema.optional(Schema.String),
  inputSchema: Schema.optional(Json),
  outputSchema: Schema.optional(Json)
})
