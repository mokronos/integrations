import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/server"
import { gatewayVersion } from "@integragents/contracts"

/** The revision the SDK serves per request, besides the 2025-era ones it negotiates. */
const statelessRevision = "2026-07-28"

export const serverCardPath = "/mcp/server-card"
export const aiCatalogPath = "/.well-known/ai-catalog.json"

const serverCardType = "application/mcp-server-card+json"

const serverCard = (mcpUrl: string) => ({
  $schema: "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
  name: "io.github.mokronos/integrations",
  version: gatewayVersion,
  title: "Integrations gateway",
  description:
    "Calls external APIs and MCP servers for an agent, holding every credential, with per-profile tools and human approval.",
  websiteUrl: "https://github.com/mokronos/integrations",
  repository: { url: "https://github.com/mokronos/integrations", source: "github" },
  remotes: [
    {
      type: "streamable-http",
      url: mcpUrl,
      supportedProtocolVersions: [statelessRevision, ...SUPPORTED_PROTOCOL_VERSIONS]
    }
  ]
})

const aiCatalog = (mcpUrl: URL) => ({
  specVersion: "1.0",
  entries: [
    {
      identifier: `urn:air:${mcpUrl.hostname}:mcp:integrations`,
      type: serverCardType,
      url: new URL(serverCardPath, mcpUrl).href
    }
  ]
})

/**
 * What a client can learn about the MCP endpoint before it connects: the
 * Server Card at its reserved location, and an AI Catalog pointing at it.
 * Neither needs a credential, and neither lists a tool.
 */
export const serveDiscoveryDocument = (request: Request, mcpUrl: string | undefined): Response | undefined => {
  if (request.method !== "GET") return undefined
  const url = new URL(request.url)
  const endpoint = new URL(mcpUrl ?? new URL("/mcp", url.origin).href)
  if (url.pathname === serverCardPath) {
    return Response.json(serverCard(endpoint.href), { headers: { "content-type": serverCardType } })
  }
  if (url.pathname === aiCatalogPath) {
    return Response.json(aiCatalog(endpoint), { headers: { "content-type": "application/ai-catalog+json" } })
  }
  return undefined
}
