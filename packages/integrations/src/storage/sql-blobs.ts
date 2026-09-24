import { createHash, randomBytes } from "node:crypto"
import { Clock, Effect, Schema, Stream } from "effect"
import { SqlClient } from "effect/unstable/sql"
import type { SqlError } from "effect/unstable/sql"
import { BlobId } from "@integragents/contracts"
import { StorageError } from "../errors.ts"
import type { BlobMetadata, BlobStore } from "./blobs.ts"

/** Rows stay well under the 2 MB value limit of Durable Object and D1 SQLite. */
const chunkBytes = 1024 * 1024

const Bytes = Schema.Union([Schema.Uint8Array, Schema.instanceOf(ArrayBuffer)])
const ChunkRows = Schema.Array(Schema.Struct({ data: Bytes }))
const IdRows = Schema.Array(Schema.Struct({ id: Schema.String }))
const MetadataRows = Schema.Array(Schema.Struct({
  content_type: Schema.String,
  filename: Schema.NullOr(Schema.String),
  bytes: Schema.Number
}))

const concat = (chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
  const joined = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0))
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return joined
}

const failure = (message: string) => (cause: SqlError.SqlError | Schema.SchemaError) =>
  new StorageError({ message: `${message}: ${cause.message}`, cause })

/**
 * Blobs as rows of the host's own database: a `blob` row per blob, written
 * last so a half-written one is never visible, and its bytes in fixed-size
 * `blob_chunk` rows.
 */
export const sqlBlobStore = (sql: SqlClient.SqlClient): BlobStore["Service"] => {
  const chunks = (id: BlobId, below: number) =>
    sql`SELECT data FROM blob_chunk WHERE blob = ${id} AND seq < ${below} ORDER BY seq`.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(ChunkRows)),
      Effect.map((rows) => rows.map((row) => new Uint8Array(row.data))),
      Effect.mapError(failure(`Could not read blob ${id}`))
    )

  const metadataOf = (id: BlobId): Effect.Effect<BlobMetadata, StorageError> =>
    sql`SELECT content_type, filename, bytes FROM blob WHERE id = ${id}`.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(MetadataRows)),
      Effect.mapError(failure(`Could not read blob ${id}`)),
      Effect.flatMap(([row]) =>
        row === undefined
          ? Effect.fail(new StorageError({ message: `Blob ${id} does not exist` }))
          : Effect.succeed({ contentType: row.content_type, filename: row.filename ?? undefined, bytes: row.bytes })
      )
    )

  const chunkCount = (bytes: number) => Math.ceil(bytes / chunkBytes)

  const discard = (id: BlobId) =>
    Effect.ignore(Effect.all([
      sql`DELETE FROM blob WHERE id = ${id}`,
      sql`DELETE FROM blob_chunk WHERE blob = ${id}`
    ]))

  return {
    write: (descriptor, content) =>
      Effect.gen(function*() {
        const id = BlobId.make(randomBytes(16).toString("hex"))
        const hash = createHash("sha256")
        let bytes = 0
        let seq = 0
        let pending: Uint8Array = new Uint8Array(0)

        const insert = (data: Uint8Array) =>
          sql`INSERT INTO blob_chunk (blob, seq, data) VALUES (${id}, ${seq++}, ${data})`.pipe(
            Effect.mapError(failure(`Could not write blob ${id}`))
          )

        yield* Stream.runForEach(content, (chunk) =>
          Effect.gen(function*() {
            hash.update(chunk)
            bytes += chunk.byteLength
            pending = concat([pending, chunk])
            while (pending.byteLength >= chunkBytes) {
              yield* insert(pending.subarray(0, chunkBytes))
              pending = pending.subarray(chunkBytes)
            }
          })).pipe(Effect.onError(() => discard(id)))
        if (pending.byteLength > 0) yield* insert(pending)

        const createdAt = yield* Clock.currentTimeMillis
        yield* sql`INSERT INTO blob (id, content_type, filename, bytes, created_at)
          VALUES (${id}, ${descriptor.contentType}, ${descriptor.filename ?? null}, ${bytes}, ${createdAt})`.pipe(
          Effect.mapError(failure(`Could not write blob ${id}`)),
          Effect.onError(() => discard(id))
        )
        return {
          id,
          bytes,
          sha256: hash.digest("hex"),
          contentType: descriptor.contentType,
          filename: descriptor.filename
        }
      }),

    readAll: (id) =>
      metadataOf(id).pipe(
        Effect.flatMap((metadata) => chunks(id, chunkCount(metadata.bytes))),
        Effect.map(concat)
      ),

    readPrefix: (id, bytes) =>
      metadataOf(id).pipe(
        Effect.flatMap(() => chunks(id, chunkCount(bytes))),
        Effect.map((read) => concat(read).subarray(0, bytes))
      ),

    open: (id) =>
      Effect.map(metadataOf(id), (metadata) => ({
        metadata,
        content: Stream.range(0, chunkCount(metadata.bytes) - 1).pipe(
          Stream.mapEffect((seq) =>
            sql`SELECT data FROM blob_chunk WHERE blob = ${id} AND seq = ${seq}`.pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(ChunkRows)),
              Effect.mapError(failure(`Could not read blob ${id}`)),
              Effect.flatMap(([row]) =>
                row === undefined
                  ? Effect.fail(new StorageError({ message: `Blob ${id} is missing chunk ${seq}` }))
                  : Effect.succeed(new Uint8Array(row.data))
              )
            )
          )
        )
      })),

    discard,

    expire: (before) =>
      sql.withTransaction(Effect.gen(function*() {
        yield* sql`DELETE FROM blob_chunk WHERE blob IN (SELECT id FROM blob WHERE created_at < ${before.getTime()})`
        return yield* sql`DELETE FROM blob WHERE created_at < ${before.getTime()} RETURNING id`.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(IdRows))
        )
      })).pipe(
        Effect.map((expired) => expired.length),
        Effect.mapError(failure("Could not expire blobs"))
      )
  }
}
