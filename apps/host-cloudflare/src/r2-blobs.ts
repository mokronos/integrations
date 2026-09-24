import { createHash } from "node:crypto"
import * as Cloudflare from "alchemy/Cloudflare"
import { RuntimeContext } from "alchemy"
import { Effect, Encoding, Layer, Stream } from "effect"
import { BlobId } from "@integragents/contracts"
import { BlobStore, StorageError } from "@integragents/host"

export const Blobs = Cloudflare.R2.Bucket("Blobs")

/** R2 takes a body of unknown length only as multipart, whose parts (all but the last) must be equal. */
const partBytes = 8 * 1024 * 1024

const concat = (chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
  const joined = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0))
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return joined
}

const storageFailure = (message: string) => (cause: Cloudflare.R2.R2Error) =>
  new StorageError({ message: `${message}: ${cause.message}`, cause })

const missing = (id: BlobId) => new StorageError({ message: `Blob ${id} does not exist` })

/** Runs an R2 operation in the current invocation, failing as the store's own error. */
const r2 = <A>(message: string, operation: Effect.Effect<A, Cloudflare.R2.R2Error, RuntimeContext>) =>
  operation.pipe(Effect.mapError(storageFailure(message)), Effect.provide(RuntimeContext.phantom))

const r2BlobStore = (bucket: Cloudflare.R2.ReadWriteBucketClient): BlobStore["Service"] => {
  const body = (id: BlobId, options?: Cloudflare.R2.GetOptions) =>
    r2(`Could not read blob ${id}`, bucket.get(id, options)).pipe(
      Effect.flatMap((object) => object === null ? Effect.fail(missing(id)) : Effect.succeed(object))
    )

  const bytesOf = (object: Cloudflare.R2.ObjectBody, id: BlobId) =>
    object.bytes().pipe(Effect.mapError(storageFailure(`Could not read blob ${id}`)))

  return {
    write: (descriptor, content) =>
      Effect.gen(function*() {
        const id = BlobId.make(Encoding.encodeHex(crypto.getRandomValues(new Uint8Array(16))))
        const metadata = {
          httpMetadata: { contentType: descriptor.contentType },
          customMetadata: descriptor.filename === undefined ? {} : { filename: descriptor.filename }
        }
        const hash = createHash("sha256")
        let bytes = 0
        let pending: Array<Uint8Array> = []
        let pendingBytes = 0
        let upload: Cloudflare.R2.MultipartUpload | undefined
        const parts: Array<Cloudflare.R2.UploadedPart> = []

        const uploadFullParts = Effect.gen(function*() {
          let buffered = concat(pending)
          while (buffered.byteLength >= partBytes) {
            upload ??= yield* r2(`Could not write blob ${id}`, bucket.createMultipartUpload(id, metadata))
            parts.push(yield* r2(`Could not write blob ${id}`, upload.uploadPart(parts.length + 1, buffered.subarray(0, partBytes))))
            buffered = buffered.subarray(partBytes)
          }
          pending = [buffered]
          pendingBytes = buffered.byteLength
        })

        yield* Stream.runForEach(content, (chunk) => {
          hash.update(chunk)
          bytes += chunk.byteLength
          pending.push(chunk)
          pendingBytes += chunk.byteLength
          return pendingBytes >= partBytes ? uploadFullParts : Effect.void
        }).pipe(
          Effect.onError(() => upload === undefined ? Effect.void : Effect.ignore(r2("abort", upload.abort())))
        )

        const rest = concat(pending)
        if (upload === undefined) {
          yield* r2(`Could not write blob ${id}`, bucket.put(id, rest, metadata))
        } else {
          if (rest.byteLength > 0) {
            parts.push(yield* r2(`Could not write blob ${id}`, upload.uploadPart(parts.length + 1, rest)))
          }
          yield* r2(`Could not write blob ${id}`, upload.complete(parts))
        }
        return {
          id,
          bytes,
          sha256: hash.digest("hex"),
          contentType: descriptor.contentType,
          filename: descriptor.filename
        }
      }),

    readAll: (id) => body(id).pipe(Effect.flatMap((object) => bytesOf(object, id))),

    readPrefix: (id, bytes) =>
      body(id, { range: { offset: 0, length: bytes } }).pipe(Effect.flatMap((object) => bytesOf(object, id))),

    open: (id) =>
      body(id).pipe(
        Effect.map((object) => ({
          metadata: {
            contentType: object.httpMetadata?.contentType ?? "application/octet-stream",
            filename: object.customMetadata?.["filename"],
            bytes: object.size
          },
          content: object.body.pipe(Stream.mapError(storageFailure(`Could not read blob ${id}`)))
        }))
      ),

    discard: (id) => Effect.ignore(r2(`Could not discard blob ${id}`, bucket.delete(id))),

    expire: (before) => {
      const page = (cursor: string | undefined, expired: number): Effect.Effect<number, StorageError> =>
        r2("Could not list blobs", bucket.list(cursor === undefined ? {} : { cursor })).pipe(
          Effect.flatMap((listed) => {
            const keys = listed.objects.filter((object) => object.uploaded < before).map((object) => object.key)
            const deleted = keys.length === 0 ? Effect.void : r2("Could not expire blobs", bucket.delete(keys))
            return Effect.andThen(
              deleted,
              listed.truncated ? page(listed.cursor, expired + keys.length) : Effect.succeed(expired + keys.length)
            )
          })
        )
      return page(undefined, 0)
    }
  }
}

/** The gateway's blob store in R2, once R2 is enabled on the account. */
export const r2Blobs = Cloudflare.R2.ReadWriteBucket(Blobs).pipe(
  Effect.map((bucket) => Layer.succeed(BlobStore, r2BlobStore(bucket))),
  Effect.provide(Cloudflare.R2.ReadWriteBucketBinding)
)
