import { describe, expect, test } from "bun:test"
import {
  bindingName,
  generateTypeScriptModule,
  typeName
} from "../src/codegen.ts"
import type { GeneratableTool } from "../src/codegen.ts"

const ticketTool: GeneratableTool = {
  alias: "tickets",
  tool: "tickets.create",
  integration: "acceptance",
  decision: "allow",
  inputSchema: {
    type: "object",
    required: ["title"],
    properties: {
      title: { type: "string" },
      priority: { type: "integer" },
      labels: { type: "array", items: { type: "string" } }
    }
  },
  outputSchema: {
    type: "object",
    required: ["id", "title"],
    properties: { id: { type: "string" }, title: { type: "string" } }
  }
}

describe("binding names", () => {
  test("turns a dotted vendor tool name into a valid identifier", () => {
    expect(bindingName("tickets", "tickets.create")).toBe("ticketsTicketsCreate")
    expect(bindingName("gmail-work", "send_email")).toBe("gmailWorkSendEmail")
  })

  test("does not start an identifier with a digit", () => {
    expect(bindingName("v2", "1create")).toMatch(/^[a-z]/)
  })

  test("derives type names from the same binding", () => {
    expect(typeName("tickets", "tickets.create", "Input")).toBe("TicketsTicketsCreateInput")
  })
})

describe("ts target", () => {
  test("emits types matching the schema's required fields", () => {
    const module_ = generateTypeScriptModule([ticketTool], "http://gateway")

    expect(module_).toContain('readonly "title": string')
    expect(module_).toContain('readonly "priority"?: number')
    expect(module_).toContain("ReadonlyArray<string>")
    expect(module_).toContain('alias: "tickets"')
    expect(module_).toContain("arguments: input")
    expect(module_).not.toContain(" as never")
  })

  test("renders enums as a union of literals", () => {
    const module_ = generateTypeScriptModule(
      [{
        ...ticketTool,
        inputSchema: {
          type: "object",
          required: ["status"],
          properties: { status: { enum: ["open", "closed"] } }
        }
      }],
      "http://gateway"
    )
    expect(module_).toContain('"open" | "closed"')
  })
})
