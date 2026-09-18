import { createHash, randomBytes } from "node:crypto"
import {
  closeSync,
  createReadStream,
  createWriteStream,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Context, Effect, Layer, Schema, Stream } from "effect"
import { BlobId } from "@mokronos/integrations-contracts"
import { StorageError } from "../errors.ts"
import { describeCause } from "../errors.ts"

export interface StoredBlob {
  readonly id: BlobId
  readonly bytes: number
  readonly sha256: string
  readonly contentType: string
  readonly filename: string | undefined
}

export interface BlobMetadata {
  readonly contentType: string
  readonly filename: string | undefined
  readonly bytes: number
}

export class BlobStore extends Context.Service<
  BlobStore,
  {
    readonly write: <E, R>(
      descriptor: { readonly contentType: string; readonly filename: string | undefined },
      content: Stream.Stream<Uint8Array, E, R>
    ) => Effect.Effect<StoredBlob, StorageError | E, R>
    readonly readAll: (id: BlobId) => Effect.Effect<Uint8Array, StorageError>
    readonly readPrefix: (id: BlobId, bytes: number) => Effect.Effect<Uint8Array, StorageError>
    readonly open: (
      id: BlobId
    ) => Effect.Effect<
      { readonly metadata: BlobMetadata; readonly content: Stream.Stream<Uint8Array, StorageError> },
      StorageError
    >
    readonly discard: (id: BlobId) => Effect.Effect<void>
  }
>()("@mokronos/integrations-host/BlobStore") {
  static readonly fileLayer = (directory: string): Layer.Layer<BlobStore> =>
    Layer.effect(BlobStore, Effect.sync(() => fileBlobStore(path.join(directory, "blobs"))))

  static readonly temporaryLayer: Layer.Layer<BlobStore> = Layer.effect(
    BlobStore,
    Effect.sync(() => fileBlobStore(mkdtempSync(path.join(tmpdir(), "integrations-blobs-"))))
  )
}

const BlobMetadataFile = Schema.Struct({
  contentType: Schema.String,
  filename: Schema.optional(Schema.String)
})

const decodeMetadataFile = Schema.decodeUnknownSync(Schema.fromJsonString(BlobMetadataFile))

const storageFailure = (message: string) => (cause: unknown) =>
  new StorageError({ message: `${message}: ${describeCause(cause)}`, cause })

const fileBlobStore = (directory: string): BlobStore["Service"] => {
  const contentPath = (id: BlobId) => path.join(directory, `${id}.bin`)
  const metadataPath = (id: BlobId) => path.join(directory, `${id}.json`)

  const metadataOf = (id: BlobId): Effect.Effect<BlobMetadata, StorageError> =>
    Effect.try({
      try: (): BlobMetadata => {
        const stored = decodeMetadataFile(readFileSync(metadataPath(id), "utf8"))
        return {
          contentType: stored.contentType,
          filename: stored.filename,
          bytes: statSync(contentPath(id)).size
        }
      },
      catch: storageFailure(`Could not read blob ${id}`)
    })

  return {
    write: (descriptor, content) =>
      Effect.gen(function*() {
        const id = BlobId.make(randomBytes(16).toString("hex"))
        yield* Effect.try({
          try: () => mkdirSync(directory, { recursive: true, mode: 0o700 }),
          catch: storageFailure(`Could not create ${directory}`)
        })
        const hash = createHash("sha256")
        const handle = createWriteStream(contentPath(id), { mode: 0o600 })
        let bytes = 0
        yield* Stream.runForEach(content, (chunk) =>
          Effect.callback<void, StorageError>((resume) => {
            hash.update(chunk)
            bytes += chunk.byteLength
            handle.write(chunk, (error) =>
              resume(
                error === undefined || error === null
                  ? Effect.void
                  : Effect.fail(storageFailure(`Could not write blob ${id}`)(error))
              )
            )
          })).pipe(
            Effect.ensuring(Effect.callback<void>((resume) => {
              handle.end(() => resume(Effect.void))
            }))
          )
        const stored: StoredBlob = {
          id,
          bytes,
          sha256: hash.digest("hex"),
          contentType: descriptor.contentType,
          filename: descriptor.filename
        }
        yield* Effect.try({
          try: () =>
            writeFileSync(
              metadataPath(id),
              JSON.stringify({
                contentType: stored.contentType,
                filename: stored.filename
              }),
              { mode: 0o600 }
            ),
          catch: storageFailure(`Could not write blob metadata ${id}`)
        })
        return stored
      }),

    readAll: (id) =>
      Effect.try({
        try: () => new Uint8Array(readFileSync(contentPath(id))),
        catch: storageFailure(`Could not read blob ${id}`)
      }),

    readPrefix: (id, bytes) =>
      Effect.try({
        try: () => {
          const target = new Uint8Array(bytes)
          const descriptor = openSync(contentPath(id), "r")
          try {
            return target.subarray(0, readSync(descriptor, target, 0, bytes, 0))
          } finally {
            closeSync(descriptor)
          }
        },
        catch: storageFailure(`Could not read blob ${id}`)
      }),

    open: (id) =>
      Effect.map(metadataOf(id), (metadata) => ({
        metadata,
        content: Stream.fromAsyncIterable(
          createReadStream(contentPath(id)),
          storageFailure(`Could not read blob ${id}`)
        ).pipe(Stream.map((chunk: Uint8Array) => new Uint8Array(chunk)))
      })),

    discard: (id) =>
      Effect.sync(() => {
        rmSync(contentPath(id), { force: true })
        rmSync(metadataPath(id), { force: true })
      })
  }
}
