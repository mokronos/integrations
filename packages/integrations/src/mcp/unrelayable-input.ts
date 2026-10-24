import { Option, Schema } from "effect"
import type { InputRequests } from "@integragents/contracts"

/**
 * The fallback for a tool's request for input that cannot reach a human: a
 * 2025-era server pushing `elicitation/create` is declined, and an
 * `input_required` round a caller cannot answer becomes a tool error that
 * says what was asked and which callers could answer it.
 */

const Elicitation = Schema.Struct({
  method: Schema.Literal("elicitation/create"),
  params: Schema.Struct({ mode: Schema.optional(Schema.Literals(["form", "url"])), message: Schema.String })
})
const decodeElicitation = Schema.decodeUnknownOption(Elicitation)

const AskedMessage = Schema.Struct({ params: Schema.Struct({ message: Schema.String }) })
const decodeAskedMessage = Schema.decodeUnknownOption(AskedMessage)

/** Only elicitations, form or URL, can be put to the caller's human; sampling and roots requests cannot. */
export const relayableInput = (requests: InputRequests): boolean =>
  Object.values(requests).every((request) => Option.isSome(decodeElicitation(request)))

const askedMessages = (requests: InputRequests): ReadonlyArray<string> =>
  Object.values(requests).flatMap((request) =>
    Option.match(decodeAskedMessage(request), { onNone: () => [], onSome: (asked) => [asked.params.message] })
  )

export const unrelayableInputMessage = (requests: InputRequests): string => {
  const asked = askedMessages(requests)
  return (
    `This tool needs interactive input${asked.length === 0 ? "" : ` (${asked.join("; ")})`}. ` +
    "Only an MCP client that supports elicitation (protocol 2026-07-28) can answer it; call the tool from one."
  )
}

/** What a 2025-era server's pushed `elicitation/create` is answered with: nobody can be asked mid-call. */
export const legacyElicitationAnswer = { action: "decline" } as const

export const declinedInputNote = (messages: ReadonlyArray<string>): string =>
  `The server asked for input the gateway cannot relay to this caller: ${messages.join("; ")}`
