import { Schema } from "effect"
import { BlobHandle } from "./blob.ts"

/**
 * What a tool returned besides its structured result: media, files and
 * resources, in MCP's content vocabulary. Bytes live in the gateway's blob
 * store and travel as handles, so a result never carries base64.
 */
export const MediaAttachment = Schema.Struct({
  type: Schema.Literals(["image", "audio"]),
  blob: BlobHandle
})
export type MediaAttachment = typeof MediaAttachment.Type

export const TextResourceAttachment = Schema.Struct({
  type: Schema.Literal("resource"),
  uri: Schema.String,
  mimeType: Schema.optional(Schema.String),
  text: Schema.String
})
export type TextResourceAttachment = typeof TextResourceAttachment.Type

export const BinaryResourceAttachment = Schema.Struct({
  type: Schema.Literal("resource"),
  uri: Schema.String,
  blob: BlobHandle
})
export type BinaryResourceAttachment = typeof BinaryResourceAttachment.Type

/** A resource the tool pointed at without including it; read it from the server that named it. */
export const ResourceLinkAttachment = Schema.Struct({
  type: Schema.Literal("resource_link"),
  uri: Schema.String,
  name: Schema.String,
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  mimeType: Schema.optional(Schema.String),
  size: Schema.optional(Schema.Number)
})
export type ResourceLinkAttachment = typeof ResourceLinkAttachment.Type

export const Attachment = Schema.Union([
  MediaAttachment,
  TextResourceAttachment,
  BinaryResourceAttachment,
  ResourceLinkAttachment
])
export type Attachment = typeof Attachment.Type
