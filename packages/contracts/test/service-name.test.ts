import { describe, expect, it } from "bun:test"
import { serviceLabel, serviceName, slugify } from "@mokronos/contracts"
import { Option } from "effect"

describe("naming a service after its host", () => {
  it("reads past the front door", () => {
    expect(serviceLabel("mcp.linear.app")).toBe("linear")
    expect(serviceLabel("api.github.com")).toBe("github")
    expect(serviceLabel("www.notion.com")).toBe("notion")
  })

  it("keeps a specific label rather than the registrable one", () => {
    expect(serviceLabel("gmailmcp.googleapis.com")).toBe("gmailmcp")
  })

  it("does not mistake a compound suffix for a name", () => {
    expect(serviceLabel("mcp.example.co.uk")).toBe("example")
    expect(serviceLabel("tools.acme.com.au")).toBe("acme")
  })

  it("prefers the leftmost label it was not told to ignore", () => {
    expect(serviceLabel("staging.acme.com")).toBe("staging")
  })

  it("leaves alone a host with nothing to strip", () => {
    expect(serviceLabel("localhost")).toBe("localhost")
    expect(serviceLabel("127.0.0.1")).toBe("127.0.0.1")
    expect(serviceLabel("linear.app")).toBe("linear")
  })

  it("falls back to the front door when that is all there is", () => {
    expect(serviceLabel("api.com")).toBe("api")
  })

  it("shows a person a capitalised word and addresses it in lower case", () => {
    expect(serviceName("mcp.linear.app")).toBe("Linear")
    expect(Option.getOrElse(slugify(serviceName("mcp.linear.app")), () => "")).toBe("linear")
  })
})
