export const mcpServerName = (clientName: string): string =>
  `integrations_${clientName.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_")}`

export const mcpConfiguration = (
  clientName: string,
  url: string,
  apiKey: string
): string =>
  JSON.stringify({
    mcpServers: {
      [mcpServerName(clientName)]: {
        type: "http",
        url,
        headers: { Authorization: `Bearer ${apiKey}` }
      }
    }
  }, null, 2)

export const apiKeyPlaceholder = "<api-key>"

export const mcpOAuthConfiguration = (url: string): string =>
  JSON.stringify({
    mcpServers: {
      integrations_gateway: { type: "http", url }
    }
  }, null, 2)
