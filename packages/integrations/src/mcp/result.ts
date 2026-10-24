import { Effect, Option, Result, Schema, Stream } from "effect"
import { Base64 } from "effect/encoding"
import { blobHandleKey, binaryNote, whenPresent } from "@integragents/contracts"
import type { Attachment, BlobHandle, Json } from "@integragents/contracts"
import { InvocationError, StorageError } from "../errors.ts"
import { BlobStore } from "../storage/blobs.ts"

const TextBlock = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })
const MediaBlock = Schema.Struct({
  type: Schema.Literals(["image", "audio"]),
  data: Schema.String,
  mimeType: Schema.String
})
const EmbeddedResourceBlock = Schema.Struct({
  type: Schema.Literal("resource"),
  resource: Schema.Union([
    Schema.Struct({ uri: Schema.String, mimeType: Schema.optional(Schema.String), text: Schema.String }),
    Schema.Struct({ uri: Schema.String, mimeType: Schema.optional(Schema.String), blob: Schema.String })
  ])
})
const ResourceLinkBlock = Schema.Struct({
  type: Schema.Literal("resource_link"),
  uri: Schema.String,
  name: Schema.String,
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  mimeType: Schema.optional(Schema.String),
  size: Schema.optional(Schema.Number)
})
const ContentBlock = Schema.Union([TextBlock, MediaBlock, EmbeddedResourceBlock, ResourceLinkBlock])
type ContentBlock = typeof ContentBlock.Type

const McpEnvelope = Schema.Struct({
  structuredContent: Schema.optional(Schema.Json),
  content: Schema.Array(Schema.Json),
  isError: Schema.optional(Schema.Boolean)
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
const decodeBlock = Schema.decodeUnknownOption(ContentBlock)
const decodeEnvelopeSchema = Schema.decodeUnknownOption(McpEnvelopeOutputSchema)
const decodeJsonString = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))

export const normalizeOutputSchema = (schema: Json): Json => (Option.isSome(decodeEnvelopeSchema(schema)) ? {} : schema)

/** A tool's answer as the gateway keeps it: the value to chain on, and whatever else it returned. */
export interface NormalizedResult {
  readonly result: Json
  readonly attachments: ReadonlyArray<Attachment>
}

const parsedText = (text: string): Json => Option.getOrElse(decodeJsonString(text), (): Json => text)

const storeBase64 = (
  tool: string,
  data: string,
  contentType: string
): Effect.Effect<BlobHandle, InvocationError | StorageError, BlobStore> =>
  Effect.gen(function* () {
    const bytes = yield* Result.match(Base64.decode(data), {
      onFailure: () =>
        Effect.fail(
          new InvocationError({ code: "tool_error", detail: `${tool} returned ${contentType} that is not base64` })
        ),
      onSuccess: Effect.succeed
    })
    const blobs = yield* BlobStore
    const stored = yield* blobs.write({ contentType, filename: undefined }, Stream.succeed(bytes))
    return {
      [blobHandleKey]: stored.id,
      bytes: stored.bytes,
      contentType,
      sha256: stored.sha256,
      note: binaryNote(contentType)
    }
  })

const attachmentOf = (
  tool: string,
  block: Exclude<ContentBlock, { readonly type: "text" }>
): Effect.Effect<Attachment, InvocationError | StorageError, BlobStore> => {
  switch (block.type) {
    case "image":
    case "audio":
      return Effect.map(storeBase64(tool, block.data, block.mimeType), (blob) => ({ type: block.type, blob }))
    case "resource": {
      const resource = block.resource
      return "text" in resource
        ? Effect.succeed({
            type: "resource",
            uri: resource.uri,
            text: resource.text,
            ...whenPresent("mimeType", resource.mimeType)
          })
        : Effect.map(
            storeBase64(tool, resource.blob, resource.mimeType ?? "application/octet-stream"),
            (blob): Attachment => ({ type: "resource", uri: resource.uri, blob })
          )
    }
    case "resource_link":
      return Effect.succeed(block)
  }
}

/**
 * The result is the tool's structured content when it gave any, else what its
 * text says, parsed when it is JSON. Media and resources ride beside it as
 * attachments, their bytes moved into the blob store.
 */
export const normalizeToolResult = (
  tool: string,
  data: Json
): Effect.Effect<NormalizedResult, InvocationError | StorageError, BlobStore> =>
  Effect.gen(function* () {
    const envelope = Option.getOrUndefined(decodeEnvelope(data))
    if (envelope === undefined) return { result: data, attachments: [] }

    const blocks = envelope.content.flatMap((block) => Option.toArray(decodeBlock(block)))
    const texts = blocks.flatMap((block) => (block.type === "text" ? [block.text] : []))

    if (envelope.isError === true) {
      return yield* new InvocationError({
        code: "tool_error",
        detail: texts.length > 0 ? texts.join("\n") : `${tool} reported an error`
      })
    }

    const attachments = yield* Effect.forEach(
      blocks.flatMap((block) => (block.type === "text" ? [] : [block])),
      (block) => attachmentOf(tool, block)
    )
    const result: Json =
      envelope.structuredContent !== undefined
        ? envelope.structuredContent
        : texts.length === 0
          ? null
          : texts.length === 1
            ? parsedText(texts[0] ?? "")
            : texts.map(parsedText)
    return { result, attachments }
  })
