import { describe, expect, it } from "bun:test"
import { serviceLabel, serviceName, slugify } from "@mokronos/contracts"
import { Option } from "effect"

/** Deriving a name from a hostname, for the servers that do not give one.
 *
 *  Every case here is a host this catalog has actually been pointed at or is
 *  plainly going to be. */
describe("naming a service after its host", () => {
  it("reads past the front door", () => {
    expect(serviceLabel("mcp.linear.app")).toBe("linear")
    expect(serviceLabel("api.github.com")).toBe("github")
    expect(serviceLabel("www.notion.com")).toBe("notion")
  })

  it("keeps a specific label rather than the registrable one", () => {
    // Google hangs every API off one registrable domain, so `googleapis` names
    // the estate and `gmailmcp` names the service.
    expect(serviceLabel("gmailmcp.googleapis.com")).toBe("gmailmcp")
  })

  it("does not mistake a compound suffix for a name", () => {
    expect(serviceLabel("mcp.example.co.uk")).toBe("example")
    expect(serviceLabel("tools.acme.com.au")).toBe("acme")
  })

  it("prefers the leftmost label it was not told to ignore", () => {
    // The rule is positional, not clever: `staging` is more specific than
    // `acme`, so it wins. Someone who wanted `acme` renames it.
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
