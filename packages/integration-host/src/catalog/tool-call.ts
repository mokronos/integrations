import { Schema } from "effect"

/** How to actually perform a tool, once it has been captured.
 *
 *  This is the *only* thing that still differs between an MCP endpoint and an
 *  OpenAPI document. Everything else about a tool — its name, description, input
 *  and output schemas, whether it is read-only — is normalised into one shape at
 *  capture time and stored.
 *
 *  So the host branches on a protocol exactly once per invocation, on a value it
 *  read out of the database, rather than re-deriving the whole tool from a live
 *  endpoint or a recompiled specification every time somebody lists tools. */

/** An MCP server is authoritative about its own tools, so all that needs
 *  recording is which one to call. The endpoint lives on the integration. */
export const McpCall = Schema.Struct({
  kind: Schema.Literal("mcp"),
  tool: Schema.String
})
export type McpCall = typeof McpCall.Type

export const ParameterLocation = Schema.Literals([
  "path",
  "query",
  "header",
  "cookie",
  "body"
])
export type ParameterLocation = typeof ParameterLocation.Type

export const HttpMethod = Schema.Literals([
  "get",
  "put",
  "post",
  "delete",
  "patch",
  "head",
  "options",
  "trace"
])
export type HttpMethod = typeof HttpMethod.Type

/** One declared parameter with the serialisation OpenAPI specifies for it.
 *  `style` and `explode` have location-dependent defaults, resolved at capture
 *  so the request builder never re-derives them. */
export const CallParameter = Schema.Struct({
  name: Schema.String,
  location: ParameterLocation,
  style: Schema.String,
  explode: Schema.Boolean,
  required: Schema.Boolean
})
export type CallParameter = typeof CallParameter.Type

/** Everything needed to turn a caller's flat arguments into an HTTP request.
 *  The server URL lives on the integration, because it is the same for every
 *  operation in a document. */
export const HttpCall = Schema.Struct({
  kind: Schema.Literal("http"),
  method: HttpMethod,
  path: Schema.String,
  parameters: Schema.Array(CallParameter),
  /** Property name to the location it must be sent in. */
  locations: Schema.Record(Schema.String, ParameterLocation),
  /** The media type the request body is sent as. */
  contentType: Schema.optional(Schema.String),
  /** Names the input property carrying the request body, when there is one. */
  bodyProperty: Schema.optional(Schema.String)
})
export type HttpCall = typeof HttpCall.Type

export const ToolCall = Schema.Union([McpCall, HttpCall])
export type ToolCall = typeof ToolCall.Type
