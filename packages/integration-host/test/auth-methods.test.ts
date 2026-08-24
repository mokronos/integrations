import { describe, expect, it } from "bun:test"
import { Option } from "effect"
import {
  findAuthMethod,
  mcpAuthMethods,
  openApiAuthMethods,
  requiresAuthentication
} from "../src/catalog/auth-methods.ts"
import type { CompiledSecurityScheme } from "../src/openapi/compile.ts"
import type { McpProbe } from "@mokronos/contracts"

const probe = (overrides: Partial<McpProbe>): McpProbe => ({
  connected: true,
  requiresAuthentication: false,
  requiresOAuth: false,
  supportsDynamicRegistration: false,
  name: "Example",
  slug: "example",
  toolCount: 1,
  serverName: "Example",
  instructions: null,
  ...overrides
})

const scheme = (overrides: Partial<CompiledSecurityScheme>): CompiledSecurityScheme => ({
  name: "scheme",
  type: "http",
  scheme: Option.none(),
  bearerFormat: Option.none(),
  in: Option.none(),
  headerName: Option.none(),
  description: Option.none(),
  openIdConnectUrl: Option.none(),
  scopes: [],
  authorizationUrl: Option.none(),
  tokenUrl: Option.none(),
  ...overrides
})

describe("MCP auth methods", () => {
  it("offers nothing to supply when the endpoint answers anonymously", () => {
    const methods = mcpAuthMethods(probe({}), "https://mcp.example.com/mcp")
    expect(methods).toHaveLength(1)
    expect(methods[0]?.kind).toBe("none")
    expect(requiresAuthentication(methods)).toBe(false)
  })

  it("offers OAuth, and reports registration, when the challenge points at metadata", () => {
    const methods = mcpAuthMethods(
      probe({
        connected: false,
        requiresAuthentication: true,
        requiresOAuth: true,
        supportsDynamicRegistration: true
      }),
      "https://mcp.linear.app/mcp"
    )
    expect(methods[0]?.kind).toBe("oauth")
    expect(methods[0]?.oauth?.discoveryUrl).toBe("https://mcp.linear.app/mcp")
    expect(methods[0]?.oauth?.supportsDynamicRegistration).toBe(true)
    expect(requiresAuthentication(methods)).toBe(true)
  })

  it("falls back to a bearer token when the wall is not an OAuth one", () => {
    const methods = mcpAuthMethods(
      probe({ connected: false, requiresAuthentication: true }),
      "https://mcp.example.com/mcp"
    )
    expect(methods[0]?.kind).toBe("header")
    expect(methods[0]?.placements?.[0]).toEqual({
      carrier: "header",
      name: "Authorization",
      prefix: "Bearer "
    })
  })
})

describe("OpenAPI auth methods", () => {
  it("places an API key where the document says it goes", () => {
    const [header] = openApiAuthMethods([
      scheme({ name: "api_key", type: "apiKey", in: Option.some("header"), headerName: Option.some("X-Api-Key") })
    ])
    expect(header?.kind).toBe("apikey")
    expect(header?.placements?.[0]).toEqual({
      carrier: "header",
      name: "X-Api-Key",
      prefix: ""
    })

    const [query] = openApiAuthMethods([
      scheme({ name: "key", type: "apiKey", in: Option.some("query") })
    ])
    expect(query?.placements?.[0]?.carrier).toBe("query")
  })

  it("declines a scheme it could not satisfy rather than offering it", () => {
    // A cookie-borne key needs a redirect chain the host does not manage, and
    // `digest` is not a bearer placement.
    expect(openApiAuthMethods([
      scheme({ name: "session", type: "apiKey", in: Option.some("cookie") })
    ])[0]?.kind).toBe("none")
    expect(openApiAuthMethods([
      scheme({ name: "digest", type: "http", scheme: Option.some("digest") })
    ])[0]?.kind).toBe("none")
  })

  it("declines an OAuth scheme with no way to run a flow", () => {
    // Petstore's `petstore_auth` is exactly this: an implicit flow with an
    // authorization URL and no token endpoint.
    const methods = openApiAuthMethods([
      scheme({
        name: "petstore_auth",
        type: "oauth2",
        authorizationUrl: Option.some("https://petstore3.swagger.io/oauth/authorize"),
        scopes: ["read:pets"]
      })
    ])
    expect(methods[0]?.kind).toBe("none")
  })

  it("accepts an OAuth scheme that declares both endpoints", () => {
    const [method] = openApiAuthMethods([
      scheme({
        name: "oauth2",
        type: "oauth2",
        authorizationUrl: Option.some("https://accounts.google.com/o/oauth2/v2/auth"),
        tokenUrl: Option.some("https://oauth2.googleapis.com/token"),
        scopes: ["https://www.googleapis.com/auth/gmail.send"]
      })
    ])
    expect(method?.kind).toBe("oauth")
    expect(method?.oauth?.scopes).toEqual(["https://www.googleapis.com/auth/gmail.send"])
  })

  it("treats a document with no schemes as open", () => {
    const methods = openApiAuthMethods([])
    expect(methods[0]?.kind).toBe("none")
    expect(requiresAuthentication(methods)).toBe(false)
  })
})

describe("findAuthMethod", () => {
  it("resolves the method a connection was created against", () => {
    const methods = openApiAuthMethods([
      scheme({ name: "api_key", type: "apiKey", in: Option.some("header") })
    ])
    expect(Option.isSome(findAuthMethod(methods, "api_key"))).toBe(true)
    // A template that has since disappeared means the connection needs redoing.
    expect(Option.isNone(findAuthMethod(methods, "gone"))).toBe(true)
  })
})
