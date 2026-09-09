import { Encoding, Result } from "effect"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export const utf8Bytes = (text: string): Uint8Array => encoder.encode(text)

export const utf8Text = (bytes: Uint8Array): string => decoder.decode(bytes)

export const concatBytes = (parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0)
  const joined = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    joined.set(part, offset)
    offset += part.byteLength
  }
  return joined
}

/**
 * Decodes a field of an envelope we wrote ourselves. Effect's decoders report
 * malformed input rather than quietly producing the bytes that happened to
 * parse, so the field is named here and the caller gets to say what it was
 * part of.
 */
export const decodeBase64Field = (field: string, encoded: string): Uint8Array =>
  Result.getOrThrowWith(
    Encoding.decodeBase64(encoded),
    () => new Error(`The ${field} is not valid base64`)
  )

export const decodeBase64UrlField = (field: string, encoded: string): Uint8Array =>
  Result.getOrThrowWith(
    Encoding.decodeBase64Url(encoded),
    () => new Error(`The ${field} is not valid base64url`)
  )
