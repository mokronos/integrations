import { Option, Schema } from "effect"
import { ToolAddress } from "./address.ts"
import { ConnectionName, IntegrationSlug, ConnectionOwner, ToolName } from "./vocabulary.ts"

/** An icon a tool's source offers for it, in MCP's own shape. */
export const ToolIcon = Schema.Struct({
  src: Schema.String,
  mimeType: Schema.optional(Schema.String),
  sizes: Schema.optional(Schema.Array(Schema.String)),
  theme: Schema.optional(Schema.Literals(["light", "dark"]))
})
export type ToolIcon = typeof ToolIcon.Type

/** Metadata a tool's source attached for its clients, such as the UI an MCP App renders its results in. */
export const ToolMeta = Schema.Record(Schema.String, Schema.Json)
export type ToolMeta = typeof ToolMeta.Type

export const ToolSummary = Schema.Struct({
  address: ToolAddress,
  name: ToolName,
  /** The name people read, when the source gave one; `name` is what addresses the tool. */
  title: Schema.optional(Schema.String),
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
  idempotent: Schema.Boolean,
  /** Reaches an open set of outside things, such as the web or other people's inboxes. Assumed when the source does not say. */
  openWorld: Schema.Boolean
})
export type ToolSummary = typeof ToolSummary.Type

export const Tool = Schema.Struct({
  ...ToolSummary.fields,
  inputSchema: Schema.optional(Schema.Json),
  outputSchema: Schema.optional(Schema.Json),
  schemaDefinitions: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
  icons: Schema.optional(Schema.Array(ToolIcon)),
  meta: Schema.optional(ToolMeta)
})
export type Tool = typeof Tool.Type

/** The MCP Apps extension, and the content type of the views it renders. */
export const mcpAppsExtension = "io.modelcontextprotocol/ui"
export const mcpAppMimeType = "text/html;profile=mcp-app"

/** The MCP App a tool's results render in: the view's gateway URI, and who may call the tool. */
export const ToolUi = Schema.Struct({
  resourceUri: Schema.String,
  /** `model` lets the agent call it, `app` lets its view call it; both when the source does not say. */
  visibility: Schema.optional(Schema.Array(Schema.Literals(["model", "app"])))
})
export type ToolUi = typeof ToolUi.Type

const DeclaredUi = Schema.Struct({
  ui: Schema.optional(
    Schema.Struct({
      resourceUri: Schema.optional(Schema.String),
      visibility: Schema.optional(Schema.Array(Schema.Literals(["model", "app"])))
    })
  ),
  "ui/resourceUri": Schema.optional(Schema.String)
})
const decodeDeclaredUi = Schema.decodeUnknownOption(DeclaredUi)

/** What a tool's `_meta` declares about its MCP App, in its source's own URIs; the flat key is the extension's older spelling. */
export const declaredUi = (meta: ToolMeta | undefined): ToolUi | undefined => {
  const declared = meta === undefined ? undefined : Option.getOrUndefined(decodeDeclaredUi(meta))
  const resourceUri = declared?.ui?.resourceUri ?? declared?.["ui/resourceUri"]
  if (resourceUri === undefined) return undefined
  const visibility = declared?.ui?.visibility
  return visibility === undefined ? { resourceUri } : { resourceUri, visibility }
}
