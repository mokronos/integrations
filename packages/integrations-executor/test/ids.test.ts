import { describe, expect, it } from "bun:test"
import { Option } from "effect"
import {
  ConnectionName,
  connectionAddress,
  IntegrationSlug,
  parseToolAddress,
  slugify,
  ToolName,
  toolAddress
} from "../src/ids.ts"

describe("tool addresses", () => {
  const parts = {
    integration: IntegrationSlug.make("gmail"),
    owner: "org" as const,
    connection: ConnectionName.make("work"),
    tool: ToolName.make("users.messages.send")
  }

  it("round-trips an address whose tool name contains dots", () => {
    const address = toolAddress(parts)
    expect(String(address)).toBe("tools.gmail.org.work.users.messages.send")
    expect(Option.getOrThrow(parseToolAddress(address))).toEqual(parts)
  })

  it("keeps the four leading segments positional", () => {
    const parsed = Option.getOrThrow(parseToolAddress("tools.slack.user.personal.chat.post"))
    expect(String(parsed.integration)).toBe("slack")
    expect(parsed.owner).toBe("user")
    expect(String(parsed.connection)).toBe("personal")
    expect(String(parsed.tool)).toBe("chat.post")
  })

  it("rejects an address that is not addressable", () => {
    for (const bad of [
      "tools.gmail.org.work",
      "gmail.org.work.send",
      "tools.gmail.admin.work.send",
      "tools..org.work.send",
      ""
    ]) {
      expect(Option.isNone(parseToolAddress(bad))).toBe(true)
    }
  })
})

describe("connection addresses", () => {
  it("is the exact prefix of the tool addresses it carries", () => {
    const reference = {
      integration: IntegrationSlug.make("gmail"),
      connection: ConnectionName.make("work")
    }
    expect(String(connectionAddress({ ...reference, owner: "org" }))).toBe("tools.gmail.org.work")
    expect(String(connectionAddress({ ...reference, owner: "user" }))).toBe("tools.gmail.user.work")
  })
})

describe("slugify", () => {
  it("derives an addressable slug from a human name", () => {
    expect(String(Option.getOrThrow(slugify("Swagger Petstore - OpenAPI 3.0"))))
      .toBe("swagger_petstore_openapi_3_0")
    expect(String(Option.getOrThrow(slugify("api.example.com")))).toBe("api_example_com")
  })

  it("has nothing to offer when a name has no addressable characters", () => {
    expect(Option.isNone(slugify("---"))).toBe(true)
    expect(Option.isNone(slugify(""))).toBe(true)
  })
})
