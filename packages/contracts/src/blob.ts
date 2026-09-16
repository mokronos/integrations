import { Schema } from "effect"

export const BlobId = Schema.String.pipe(Schema.brand("BlobId"))
export type BlobId = typeof BlobId.Type

/**
 * Distinctive enough that a real API response cannot collide with it: a plain
 * `kind: "blob"` would eventually arrive as someone's actual data.
 */
export const blobHandleKey = "@integrations/blob"

export const BlobHandle = Schema.Struct({
  [blobHandleKey]: BlobId,
  bytes: Schema.Number,
  contentType: Schema.String,
  sha256: Schema.String,
  note: Schema.String,
  filename: Schema.optional(Schema.String),
  preview: Schema.optional(Schema.String),
  /** Filled in by whichever client materialized the bytes onto local disk. */
  path: Schema.optional(Schema.String)
})
export type BlobHandle = typeof BlobHandle.Type

export const defaultMaxInlineBytes = 64 * 1024

export const isTextualContentType = (contentType: string): boolean => {
  const kind = contentType.split(";")[0]?.trim().toLowerCase() ?? ""
  return kind.startsWith("text/") ||
    kind === "application/json" ||
    kind === "application/x-ndjson" ||
    kind === "application/ndjson" ||
    kind === "application/xml" ||
    /^application\/[\w.+-]+\+(?:json|xml)$/.test(kind)
}

export const describeBytes = (bytes: number): string =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
    ? `${(bytes / 1024).toFixed(1)} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`

export const binaryNote = (contentType: string): string =>
  `${contentType} is binary and cannot be carried in JSON without corrupting it. ` +
  `The full response was written to disk; read it from "path".`

export const oversizeNote = (
  contentType: string,
  bytes: number,
  limit: number
): string =>
  `${describeBytes(bytes)} of ${contentType} exceeds the ${describeBytes(limit)} inline limit. ` +
  `The full response was written to disk; read it from "path". ` +
  `Filter it with jq or similar rather than reading the whole file into context.`

const filenamePattern = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i

export const filenameFromDisposition = (
  disposition: string | undefined
): string | undefined => {
  if (disposition === undefined) return undefined
  const matched = filenamePattern.exec(disposition)?.[1]
  if (matched === undefined) return undefined
  const decoded = decodeURIComponent(matched).split(/[/\\]/).pop()
  return decoded === undefined || decoded.length === 0 ? undefined : decoded
}
