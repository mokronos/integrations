import { describe, expect, it } from "bun:test"
import type { EndpointClassification, Integration } from "@mokronos/contracts"
import { createIntegrationProvisioning } from "../src/facade/provisioning.ts"

/** Installing what a URL turned out to be, under the name the caller chose.
 *
 *  The dependencies are hand-built rather than stubbed through the whole host:
 *  what is under test is which name reaches the catalog, so the catalog only
 *  has to record what it was asked for. */

const classification: EndpointClassification = {
  kind: "mcp",
  endpoint: "https://gmailmcp.googleapis.com/mcp/v1",
  name: "Gmailmcp",
  slug: "gmailmcp"
}

const installed = (
  overrides: Partial<Integration> & { readonly slug: string }
): Integration => ({
  name: overrides.slug,
  description: "",
  kind: "mcp",
  canRemove: true,
  canRefresh: true,
  authMethods: [{ id: "none", label: "No authentication", kind: "none", template: "none" }],
  displayUrl: classification.endpoint,
  ...overrides
})

const dependencies = (options: {
  readonly existing?: Integration
  readonly added: Array<{ readonly slug: string; readonly name: string }>
}) => ({
  catalog: {
    classify: async () => classification,
    addMcp: async (input: { readonly slug: string; readonly name: string }) => {
      options.added.push({ slug: input.slug, name: input.name })
      return input.slug
    },
    addOpenApi: async () => {
      throw new Error("not an OpenAPI document")
    },
    find: async (slug: string) => {
      if (options.existing !== undefined && options.existing.slug === slug) {
        return options.existing
      }
      const added = options.added.find((entry) => entry.slug === slug)
      return added === undefined ? undefined : installed(added)
    }
  },
  connections: { ensure: async () => false },
  tools: { list: async () => [] }
})

describe("provisioning a discovered URL", () => {
  it("installs under the name and slug the caller chose", async () => {
    const added: Array<{ readonly slug: string; readonly name: string }> = []
    const provisioning = createIntegrationProvisioning(dependencies({ added }))

    const result = await provisioning.provision(classification.endpoint, {
      slug: "gmail",
      name: "Gmail"
    })

    expect(added).toEqual([{ slug: "gmail", name: "Gmail" }])
    expect(result.integration.slug).toBe("gmail")
  })

  it("falls back to what the endpoint said it was", async () => {
    const added: Array<{ readonly slug: string; readonly name: string }> = []
    const provisioning = createIntegrationProvisioning(dependencies({ added }))

    await provisioning.provision(classification.endpoint, {})

    expect(added).toEqual([{ slug: "gmailmcp", name: "Gmailmcp" }])
  })

  it("is idempotent for the URL already installed under that slug", async () => {
    const added: Array<{ readonly slug: string; readonly name: string }> = []
    const existing = installed({ slug: "gmailmcp", name: "Gmail" })
    const provisioning = createIntegrationProvisioning(dependencies({ existing, added }))

    const result = await provisioning.provision(classification.endpoint, {})

    // Nothing installed a second time, and the name a human already gave it
    // survives — rediscovery is not a reset.
    expect(added).toEqual([])
    expect(result.integration.name).toBe("Gmail")
  })

  it("refuses a name already taken by a different endpoint", async () => {
    const added: Array<{ readonly slug: string; readonly name: string }> = []
    const existing = installed({
      slug: "gmail",
      name: "Gmail",
      displayUrl: "https://mail.example.com/mcp"
    })
    const provisioning = createIntegrationProvisioning(dependencies({ existing, added }))

    // Returning the other integration here would report success for an
    // endpoint that was never installed.
    const outcome = await provisioning.provision(classification.endpoint, { slug: "gmail" })
      .then(() => undefined)
      .catch((error: Error) => error)

    expect(outcome?.message).toContain("https://mail.example.com/mcp")
    expect(added).toEqual([])
  })
})
