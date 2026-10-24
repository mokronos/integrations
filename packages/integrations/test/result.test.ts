import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { blobHandleKey } from "@integragents/contracts"
import { normalizeOutputSchema, normalizeToolResult } from "../src/mcp/result.ts"
import { BlobStore } from "../src/storage/blobs.ts"

const normalize = (tool: string, data: Parameters<typeof normalizeToolResult>[1]) =>
  Effect.result(normalizeToolResult(tool, data)).pipe(Effect.provide(BlobStore.temporaryLayer))

describe("normalising a tool result", () => {
  it.effect("prefers structured content over the text rendering of it", () =>
    Effect.gen(function* () {
      const out = yield* normalize("t", {
        content: [{ type: "text", text: '{"a":1}' }],
        structuredContent: { a: 1 }
      })
      expect(out).toMatchObject({ _tag: "Success", success: { result: { a: 1 }, attachments: [] } })
    })
  )

  it.effect("parses a sole text block that carries JSON", () =>
    Effect.gen(function* () {
      const out = yield* normalize("t", {
        content: [{ type: "text", text: '{"ok":true}' }]
      })
      expect(out).toMatchObject({ _tag: "Success", success: { result: { ok: true } } })
    })
  )

  it.effect("returns a sole text block that is not JSON as the string it is", () =>
    Effect.gen(function* () {
      const out = yield* normalize("t", {
        content: [{ type: "text", text: "plain words" }]
      })
      expect(out).toMatchObject({ _tag: "Success", success: { result: "plain words" } })
    })
  )

  it.effect("turns a flagged error into a real failure", () =>
    Effect.gen(function* () {
      const out = yield* normalize("send_email", {
        content: [{ type: "text", text: "mailbox is full" }],
        isError: true
      })
      expect(out._tag).toBe("Failure")
      if (out._tag === "Failure" && out.failure._tag === "InvocationError") {
        expect(out.failure.code).toBe("tool_error")
        expect(out.failure.detail).toBe("mailbox is full")
      }
    })
  )

  it.effect("names the tool when a flagged error carries no text", () =>
    Effect.gen(function* () {
      const out = yield* normalize("send_email", { content: [], isError: true })
      expect(out._tag).toBe("Failure")
      if (out._tag === "Failure" && out.failure._tag === "InvocationError") {
        expect(out.failure.detail).toContain("send_email")
      }
    })
  )

  it.effect("passes a value that is not an envelope straight through", () =>
    Effect.gen(function* () {
      for (const value of [{ total: 2 }, [1, 2, 3], "text", 7, null]) {
        const out = yield* normalize("t", value)
        expect(out).toMatchObject({ _tag: "Success", success: { result: value, attachments: [] } })
      }
    })
  )

  it.effect("keeps every text block rather than picking one", () =>
    Effect.gen(function* () {
      const content = [
        { type: "text", text: "one" },
        { type: "text", text: '{"two":2}' }
      ]
      const out = yield* normalize("t", { content })
      expect(out).toMatchObject({ _tag: "Success", success: { result: ["one", { two: 2 }] } })
    })
  )

  it.effect("moves media into the blob store and keeps it beside the result", () =>
    Effect.gen(function* () {
      const out = yield* normalize("render", {
        content: [
          { type: "text", text: '{"pages":1}' },
          { type: "image", data: btoa("png bytes"), mimeType: "image/png" },
          { type: "resource_link", uri: "file:///report.pdf", name: "report.pdf" },
          { type: "resource", resource: { uri: "note://1", mimeType: "text/plain", text: "hello" } }
        ]
      })
      expect(out).toMatchObject({
        _tag: "Success",
        success: {
          result: { pages: 1 },
          attachments: [
            { type: "image", blob: { contentType: "image/png", bytes: 9 } },
            { type: "resource_link", uri: "file:///report.pdf", name: "report.pdf" },
            { type: "resource", uri: "note://1", text: "hello" }
          ]
        }
      })
      if (out._tag === "Success") {
        const image = out.success.attachments[0]
        expect(image !== undefined && "blob" in image ? image.blob[blobHandleKey] : undefined).toBeTypeOf("string")
      }
    })
  )
})

describe("normalising an output schema", () => {
  it("replaces the envelope schema, which describes a wrapper we remove", () => {
    expect(
      normalizeOutputSchema({
        type: "object",
        properties: {
          content: { type: "array" },
          structuredContent: { type: "object" },
          isError: { const: false }
        }
      })
    ).toEqual({})
  })

  it("leaves a schema that describes the tool's own output alone", () => {
    const schema = { type: "object", properties: { total: { type: "integer" } } }
    expect(normalizeOutputSchema(schema)).toEqual(schema)
  })
})
