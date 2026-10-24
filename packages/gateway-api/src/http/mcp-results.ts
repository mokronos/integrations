import type { CallToolResult, ContentBlock } from "@modelcontextprotocol/server"
import { Effect, Option, Schema } from "effect"
import { Base64 } from "effect/encoding"
import {
  BlobHandle,
  blobHandleKey,
  blobResourceUri,
  connectionResourceUri,
  InvocationOutcome,
  isJsonObject,
  whenPresent
} from "@integragents/contracts"
import type { Alias, Attachment, BlobId, Json, JsonEncodable } from "@integragents/contracts"
import { BlobStore } from "@integragents/integrations"

import { sessionLink } from "./mcp-tools.ts"
import type { CallOutcome } from "./mcp-tools.ts"

/** Media up to this size travels inline, where the model sees it; larger bytes are linked. */
const inlineMediaBytes = 2 * 1024 * 1024

/** Printed as it travelled: the decoded outcome carries a Date, JSON does not. */
const encodeOutcome = Schema.encodeSync(InvocationOutcome)

const decodeHandle = Schema.decodeUnknownOption(BlobHandle)

const textOf = (value: JsonEncodable): ContentBlock => ({ type: "text", text: JSON.stringify(value) })

const blobLink = (handle: BlobHandle): ContentBlock => ({
  type: "resource_link",
  uri: blobResourceUri(handle[blobHandleKey]),
  name: handle.filename ?? handle[blobHandleKey],
  mimeType: handle.contentType,
  size: handle.bytes
})

/** Every blob handle a JSON value carries, wherever it sits. */
const handlesIn = (value: Json): ReadonlyArray<BlobHandle> =>
  Option.match(decodeHandle(value), {
    onSome: (handle) => [handle],
    onNone: () =>
      Array.isArray(value)
        ? value.flatMap(handlesIn)
        : isJsonObject(value)
          ? Object.values(value).flatMap(handlesIn)
          : []
  })

const mediaContent = (type: "image" | "audio", handle: BlobHandle) =>
  handle.bytes > inlineMediaBytes
    ? Effect.succeed(blobLink(handle))
    : Effect.gen(function* () {
        const blobs = yield* BlobStore
        const bytes = yield* blobs.readAll(handle[blobHandleKey] satisfies BlobId)
        return { type, data: Base64.encode(bytes), mimeType: handle.contentType } satisfies ContentBlock
      }).pipe(Effect.orElseSucceed(() => blobLink(handle)))

const contentOf = (alias: Alias, attachment: Attachment): Effect.Effect<ContentBlock, never, BlobStore> => {
  switch (attachment.type) {
    case "image":
    case "audio":
      return mediaContent(attachment.type, attachment.blob)
    case "resource":
      return "text" in attachment
        ? Effect.succeed({
            type: "resource",
            resource: {
              uri: connectionResourceUri(alias, attachment.uri),
              text: attachment.text,
              ...whenPresent("mimeType", attachment.mimeType)
            }
          })
        : Effect.succeed(blobLink(attachment.blob))
    case "resource_link":
      return Effect.succeed({ ...attachment, uri: connectionResourceUri(alias, attachment.uri) })
  }
}

/** What an agent should make of a call that did not produce the tool's result, and what to do next. */
const explain = (outcome: Exclude<CallOutcome, { readonly status: "succeeded" }>): string => {
  switch (outcome.status) {
    case "pending":
      return [
        `The call is held until a human approves it (approval ${outcome.approvalId}).`,
        ...(outcome.approvalUrl === undefined ? [] : [`They can decide it at ${outcome.approvalUrl}.`]),
        "Do not approve it yourself. Once it is decided, call the tool again with the same arguments to get its result."
      ].join(" ")
    case "denied":
      return `The call did not run: ${outcome.reason}.`
    case "failed":
      return `The call failed: ${outcome.message}`
    case "authorization-required": {
      const link = sessionLink(outcome.session.state)
      const who = outcome.subject ?? "a person who can authorize it"
      const why =
        outcome.scopes === undefined
          ? `${outcome.integration} acts for ${outcome.subject ?? "a user"}, who has not authorized it yet.`
          : `${outcome.integration} needs more access for this call (${outcome.scopes.join(" ")}).`
      return (
        why +
        (link === undefined ? "" : ` Ask ${who} to authorize it at ${link}.`) +
        " Do not open it yourself. Call the tool again once they have."
      )
    }
  }
}

/**
 * A succeeded call answers with the tool's result as structured content and
 * its text rendering, then the media and resources it returned. Any other
 * outcome is an error result carrying the outcome, so the agent reads why and
 * what to do next, and a client checking the tool's output schema never sees
 * a value that is not the tool's.
 */
export const outcomeResult = (alias: Alias, outcome: CallOutcome): Effect.Effect<CallToolResult, never, BlobStore> => {
  if (outcome.status !== "succeeded") {
    const encoded = encodeOutcome(outcome)
    return Effect.succeed({
      content: [{ type: "text", text: explain(outcome) }, textOf(encoded)],
      structuredContent: encoded,
      isError: true
    })
  }
  return Effect.map(
    Effect.forEach(outcome.attachments ?? [], (attachment) => contentOf(alias, attachment)),
    (attachments): CallToolResult => ({
      content: [textOf(outcome.result), ...handlesIn(outcome.result).map(blobLink), ...attachments],
      structuredContent: outcome.result
    })
  )
}

/** What a gateway operation answered, for the tools that are not a call to an integration. */
export const valueResult = (value: JsonEncodable, failed: boolean): CallToolResult => ({
  content: [textOf(value)],
  structuredContent: value,
  isError: failed
})
