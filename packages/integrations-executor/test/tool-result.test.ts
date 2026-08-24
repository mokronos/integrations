import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { normalizeOutputSchema, normalizeToolResult } from "../src/tool-result.ts"

const result = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.result(effect))

describe("normalising a tool result", () => {
  it("prefers structured content over the text rendering of it", async () => {
    const out = await result(normalizeToolResult("t", {
      content: [{ type: "text", text: "{\"a\":1}" }],
      structuredContent: { a: 1 }
    }))
    expect(out).toMatchObject({ _tag: "Success", success: { a: 1 } })
  })

  it("parses a sole text block that carries JSON", async () => {
    const out = await result(normalizeToolResult("t", {
      content: [{ type: "text", text: "{\"ok\":true}" }]
    }))
    expect(out).toMatchObject({ _tag: "Success", success: { ok: true } })
  })

  it("returns a sole text block that is not JSON as the string it is", async () => {
    const out = await result(normalizeToolResult("t", {
      content: [{ type: "text", text: "plain words" }]
    }))
    expect(out).toMatchObject({ _tag: "Success", success: "plain words" })
  })

  it("turns a flagged error into a real failure", async () => {
    const out = await result(normalizeToolResult("send_email", {
      content: [{ type: "text", text: "mailbox is full" }],
      isError: true
    }))
    expect(out._tag).toBe("Failure")
    if (out._tag === "Failure") {
      expect(out.failure.code).toBe("tool_error")
      expect(out.failure.detail).toBe("mailbox is full")
    }
  })

  it("names the tool when a flagged error carries no text", async () => {
    const out = await result(normalizeToolResult("send_email", { content: [], isError: true }))
    expect(out._tag).toBe("Failure")
    if (out._tag === "Failure") {
      expect(out.failure.detail).toContain("send_email")
    }
  })

  it("passes a value that is not an envelope straight through", async () => {
    // An OpenAPI result goes through the same function, so it must not be
    // reinterpreted.
    for (const value of [{ total: 2 }, [1, 2, 3], "text", 7, null]) {
      const out = await result(normalizeToolResult("t", value))
      expect(out).toMatchObject({ _tag: "Success", success: value })
    }
  })

  it("keeps multiple content blocks rather than picking one", async () => {
    const content = [
      { type: "text", text: "one" },
      { type: "text", text: "two" }
    ]
    const out = await result(normalizeToolResult("t", { content }))
    expect(out).toMatchObject({ _tag: "Success", success: content })
  })
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
