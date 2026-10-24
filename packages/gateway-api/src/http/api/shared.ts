import { Schema } from "effect"
import { Alias, ConnectionRef, ToolDecision, ToolIcon, ToolMeta, ToolUi } from "@integragents/contracts"

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
  openWorld: Schema.optional(Schema.Boolean),
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  inputSchema: Schema.optional(Json),
  outputSchema: Schema.optional(Json),
  icons: Schema.optional(Schema.Array(ToolIcon)),
  meta: Schema.optional(ToolMeta),
  ui: Schema.optional(ToolUi)
})
