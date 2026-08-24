import { Effect, Option, Schema } from "effect"
import { InvocationError } from "../errors.ts"

/** Reading an MCP `tools/call` envelope.
 *
 *  MCP wraps every result in `{ content, structuredContent?, isError? }`. A tool
 *  caller wants the payload, not the wrapper, and a caller that has to unwrap it
 *  will eventually forget to check `isError` — so unwrapping happens once, here,
 *  and a flagged error becomes a real failure. */

type Json = typeof Schema.Json.Type

const McpEnvelope = Schema.Struct({
  structuredContent: Schema.optional(Schema.Json),
  content: Schema.optional(Schema.Array(Schema.Json)),
  isError: Schema.optional(Schema.Boolean)
})

const McpTextContent = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String
})

/** The envelope shape an MCP server publishes as a tool's `outputSchema` when
 *  it has nothing more specific to say. Recognising it lets the tool's
 *  advertised output match what this module actually returns. */
const McpEnvelopeOutputSchema = Schema.Struct({
  type: Schema.optional(Schema.Literal("object")),
  properties: Schema.Struct({
    content: Schema.Json,
    structuredContent: Schema.optional(Schema.Json),
    isError: Schema.Struct({ const: Schema.Literal(false) })
  })
})

const decodeEnvelope = Schema.decodeUnknownOption(McpEnvelope)
const decodeText = Schema.decodeUnknownOption(McpTextContent)
const decodeEnvelopeSchema = Schema.decodeUnknownOption(McpEnvelopeOutputSchema)
const decodeJsonString = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))

/** An envelope-shaped output schema describes the wrapper this module removes,
 *  so publishing it would describe the wrong thing. Replaced with the open
 *  schema, which is the honest claim: whatever the tool returns. */
export const normalizeOutputSchema = (schema: Json): Json =>
  Option.isSome(decodeEnvelopeSchema(schema)) ? {} : schema

const soleText = (content: ReadonlyArray<Json>): Option.Option<string> => {
  const first = content[0]
  if (content.length !== 1 || first === undefined) return Option.none()
  return Option.map(decodeText(first), (text) => text.text)
}

/** Unwraps an MCP result. A non-envelope value passes through untouched, so the
 *  same function is safe to apply to an OpenAPI result. */
export const normalizeToolResult = (
  tool: string,
  data: Json
): Effect.Effect<Json, InvocationError> => {
  const envelope = Option.getOrUndefined(decodeEnvelope(data))
  if (envelope === undefined) return Effect.succeed(data)

  const content = envelope.content ?? []
  const text = soleText(content)

  if (envelope.isError === true) {
    return Effect.fail(new InvocationError({
      code: "tool_error",
      detail: Option.getOrElse(text, () => `${tool} reported an error`)
    }))
  }
  if (envelope.structuredContent !== undefined) {
    return Effect.succeed(envelope.structuredContent)
  }
  return Effect.succeed(Option.match(text, {
    onNone: (): Json => content.length > 0 ? content : data,
    // A server that can only speak text often still sends JSON in it; a caller
    // reading a `structuredContent`-shaped schema should not have to parse the
    // string itself.
    onSome: (only) => Option.getOrElse(decodeJsonString(only), (): Json => only)
  }))
}
