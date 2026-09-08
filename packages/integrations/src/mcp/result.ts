import { Effect, Option, Schema } from "effect"
import { InvocationError } from "../errors.ts"

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

export const normalizeOutputSchema = (schema: Json): Json =>
  Option.isSome(decodeEnvelopeSchema(schema)) ? {} : schema

const soleText = (content: ReadonlyArray<Json>): Option.Option<string> => {
  const first = content[0]
  if (content.length !== 1 || first === undefined) return Option.none()
  return Option.map(decodeText(first), (text) => text.text)
}

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
    onSome: (only) => Option.getOrElse(decodeJsonString(only), (): Json => only)
  }))
}
