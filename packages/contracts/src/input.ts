import { Schema } from "effect"

/**
 * What a tool asked its caller before it can finish (MCP `input_required`),
 * keyed the way the tool named each request.
 */
export const InputRequests = Schema.Record(Schema.String, Schema.Json)
export type InputRequests = typeof InputRequests.Type

/** The caller's answers to `InputRequests`, under the same keys. */
export const InputResponses = Schema.Record(Schema.String, Schema.Json)
export type InputResponses = typeof InputResponses.Type

/** One round of a tool that asks for input: its requests and the opaque state the next round echoes. */
export const InputRound = Schema.Struct({
  inputRequests: InputRequests,
  requestState: Schema.optional(Schema.String)
})
export type InputRound = typeof InputRound.Type

/** A round's answers, sent with the same call again. */
export const InputAnswer = Schema.Struct({
  inputResponses: InputResponses,
  requestState: Schema.optional(Schema.String)
})
export type InputAnswer = typeof InputAnswer.Type
