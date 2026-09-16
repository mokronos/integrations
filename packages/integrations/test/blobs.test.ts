import { createHash } from "node:crypto"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Option, Schema, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { BlobHandle, blobHandleKey } from "@integrations/contracts"
import { OpenApiInvoker } from "../src/openapi/invoke.ts"
import { BlobStore } from "../src/storage/blobs.ts"

const services = OpenApiInvoker.layer.pipe(
  Layer.provideMerge(BlobStore.temporaryLayer),
  Layer.provide(FetchHttpClient.layer)
)

const decodeHandle = Schema.decodeUnknownSync(BlobHandle)

const zipBytes = new Uint8Array(200_000)
for (let index = 0; index < zipBytes.length; index += 1) {
  zipBytes[index] = (index * 7 + 13) % 256
}

const server = Effect.acquireRelease(
  Effect.sync(() =>
    Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === "/binary") {
          return new Response(zipBytes, {
            headers: {
              "content-type": "application/zip",
              "content-disposition": 'attachment; filename="archive.zip"'
            }
          })
        }
        if (url.pathname === "/upload") {
          return request.bytes().then((received) =>
            new Response(
              JSON.stringify({
                bytes: received.length,
                sha256: createHash("sha256").update(received).digest("hex"),
                contentType: request.headers.get("content-type")
              }),
              { headers: { "content-type": "application/json" } }
            )
          )
        }
        if (url.pathname === "/large") {
          return new Response(JSON.stringify({ rows: Array.from({ length: 4000 }, (_, i) => i) }), {
            headers: { "content-type": "application/json" }
          })
        }
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" }
        })
      }
    })
  ),
  (running) => Effect.promise(() => running.stop())
)

const upload = (baseUrl: string, blobId: string) =>
  Effect.flatMap(OpenApiInvoker, (invoker) =>
    invoker.call({
      call: {
        kind: "http",
        method: "post",
        path: "/upload",
        parameters: [],
        locations: { body: "body" },
        bodyProperty: "body",
        contentType: "application/octet-stream"
      },
      tool: "reference.upload",
      server: baseUrl,
      input: { body: { [blobHandleKey]: blobId } },
      credential: Option.none()
    }))

const invoke = (baseUrl: string, path: string, maxInlineBytes: number) =>
  Effect.flatMap(OpenApiInvoker, (invoker) =>
    invoker.call({
      call: {
        kind: "http",
        method: "get",
        path,
        parameters: [],
        locations: {}
      },
      tool: "reference.download",
      server: baseUrl,
      input: {},
      credential: Option.none(),
      maxInlineBytes
    }))

describe("byte-faithful responses", () => {
  it.live("preserves binary content exactly instead of decoding it as text", () =>
    Effect.gen(function*() {
      const running = yield* server
      const result = yield* invoke(running.url.origin, "/binary", 64 * 1024)
      const handle = decodeHandle(result)

      expect(handle.contentType).toBe("application/zip")
      expect(handle.bytes).toBe(zipBytes.length)
      expect(handle.filename).toBe("archive.zip")

      const blobs = yield* BlobStore
      const stored = yield* blobs.readAll(handle[blobHandleKey])
      expect(stored).toEqual(zipBytes)
      expect(handle.sha256).toBe(createHash("sha256").update(zipBytes).digest("hex"))
    }).pipe(Effect.provide(services), Effect.scoped))

  it.live("writes oversized text to disk rather than truncating it", () =>
    Effect.gen(function*() {
      const running = yield* server
      const result = yield* invoke(running.url.origin, "/large", 1024)
      const handle = decodeHandle(result)

      expect(handle.note).toContain("exceeds")
      expect(handle.preview).toContain("rows")

      const blobs = yield* BlobStore
      const stored = yield* blobs.readAll(handle[blobHandleKey])
      const parsed: unknown = JSON.parse(new TextDecoder().decode(stored))
      expect(Schema.decodeUnknownSync(Schema.Struct({ rows: Schema.Array(Schema.Number) }))(parsed).rows)
        .toHaveLength(4000)
    }).pipe(Effect.provide(services), Effect.scoped))

  it.live("streams stored bytes back out as a request body", () =>
    Effect.gen(function*() {
      const running = yield* server
      const blobs = yield* BlobStore
      const stored = yield* blobs.write(
        { contentType: "application/zip", filename: "archive.zip" },
        Stream.succeed(zipBytes)
      )

      const echoed = yield* upload(running.url.origin, stored.id)
      const report = Schema.decodeUnknownSync(Schema.Struct({
        bytes: Schema.Number,
        sha256: Schema.String,
        contentType: Schema.String
      }))(echoed)

      expect(report.bytes).toBe(zipBytes.length)
      expect(report.sha256).toBe(createHash("sha256").update(zipBytes).digest("hex"))
      expect(report.contentType).toBe("application/zip")
    }).pipe(Effect.provide(services), Effect.scoped))

  it.live("keeps small JSON inline", () =>
    Effect.gen(function*() {
      const running = yield* server
      const result = yield* invoke(running.url.origin, "/small", 64 * 1024)
      expect(result).toEqual({ ok: true })
    }).pipe(Effect.provide(services), Effect.scoped))
})
