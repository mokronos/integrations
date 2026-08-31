import { Schema } from "effect"
import { ToolAddress } from "./address.ts"
import { OwnerTier } from "./vocabulary.ts"

/** A single named operation an integration exposes: the smallest unit that can
 * be invoked, authorized, or approved. */

/** A tool's identity and purpose without its schemas. Listing at this level
 *  keeps browsing a large integration cheap; {@link Tool} is the follow-up for
 *  one chosen tool.
 *
 *  `owner` and `connection` spell out the two address segments between the
 *  integration and the name, so a reader never parses `address` back apart to
 *  learn which credentials a tool runs under. */
export const ToolSummary = Schema.Struct({
  address: ToolAddress,
  name: Schema.String,
  description: Schema.String,
  integration: Schema.String,
  owner: OwnerTier,
  connection: Schema.String,
  /** The policy decision a newly cataloged tool starts from.
   *
   *  `allow` is reserved for a tool whose own source declares it read-only —
   *  MCP's `readOnlyHint`, or a safe HTTP method. Everything else needs a human.
   *  An operator can widen a policy; a call that already happened cannot be
   *  narrowed, so this is the direction to fail in. */
  defaultDecision: Schema.Literals(["allow", "require_approval"])
})
export type ToolSummary = typeof ToolSummary.Type

/** One tool with everything needed to call it. Schemas are self-contained:
 *  definitions a schema reaches travel with it under `$defs`. */
export const Tool = Schema.Struct({
  ...ToolSummary.fields,
  inputSchema: Schema.optional(Schema.Json),
  outputSchema: Schema.optional(Schema.Json),
  schemaDefinitions: Schema.optional(Schema.Record(Schema.String, Schema.Json))
})
export type Tool = typeof Tool.Type
