import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { normalizeOutputSchema, normalizeToolResult } from "../src/mcp/result.ts"

describe("normalising a tool result", () => {
  it.effect("prefers structured content over the text rendering of it", () =>
    Effect.gen(function*() {
      const out = yield* Effect.result(normalizeToolResult("t", {
        content: [{ type: "text", text: "{\"a\":1}" }],
        structuredContent: { a: 1 }
      }))
      expect(out).toMatchObject({ _tag: "Success", success: { a: 1 } })
    }))

  it.effect("parses a sole text block that carries JSON", () =>
    Effect.gen(function*() {
      const out = yield* Effect.result(normalizeToolResult("t", {
        content: [{ type: "text", text: "{\"ok\":true}" }]
      }))
      expect(out).toMatchObject({ _tag: "Success", success: { ok: true } })
    }))

  it.effect("returns a sole text block that is not JSON as the string it is", () =>
    Effect.gen(function*() {
      const out = yield* Effect.result(normalizeToolResult("t", {
        content: [{ type: "text", text: "plain words" }]
      }))
      expect(out).toMatchObject({ _tag: "Success", success: "plain words" })
    }))

  it.effect("turns a flagged error into a real failure", () =>
    Effect.gen(function*() {
      const out = yield* Effect.result(normalizeToolResult("send_email", {
        content: [{ type: "text", text: "mailbox is full" }],
        isError: true
      }))
      expect(out._tag).toBe("Failure")
      if (out._tag === "Failure") {
        expect(out.failure.code).toBe("tool_error")
        expect(out.failure.detail).toBe("mailbox is full")
      }
    }))

  it.effect("names the tool when a flagged error carries no text", () =>
    Effect.gen(function*() {
      const out = yield* Effect.result(normalizeToolResult("send_email", { content: [], isError: true }))
      expect(out._tag).toBe("Failure")
      if (out._tag === "Failure") {
        expect(out.failure.detail).toContain("send_email")
      }
    }))

  it.effect("passes a value that is not an envelope straight through", () =>
    Effect.gen(function*() {
      for (const value of [{ total: 2 }, [1, 2, 3], "text", 7, null]) {
        const out = yield* Effect.result(normalizeToolResult("t", value))
        expect(out).toMatchObject({ _tag: "Success", success: value })
      }
    }))

  it.effect("keeps multiple content blocks rather than picking one", () =>
    Effect.gen(function*() {
      const content = [
        { type: "text", text: "one" },
        { type: "text", text: "two" }
      ]
      const out = yield* Effect.result(normalizeToolResult("t", { content }))
      expect(out).toMatchObject({ _tag: "Success", success: content })
    }))
})

describe("normalising an output schema", () => {
  it("replaces the envelope schema, which describes a wrapper we remove", () => {
    expect(normalizeOutputSchema({
      type: "object",
      properties: {
        content: { type: "array" },
        structuredContent: { type: "object" },
        isError: { const: false }
      }
    })).toEqual({})
  })

  it("leaves a schema that describes the tool's own output alone", () => {
    const schema = { type: "object", properties: { total: { type: "integer" } } }
    expect(normalizeOutputSchema(schema)).toEqual(schema)
  })
})
