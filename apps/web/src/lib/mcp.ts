export const mcpConfiguration = (
  clientName: string,
  url: string,
  apiKey: string
): string =>
  JSON.stringify({
    mcpServers: {
      [clientName]: {
        type: "http",
        url,
        headers: { Authorization: `Bearer ${apiKey}` }
      }
    }
  }, null, 2)

export const apiKeyPlaceholder = "<api-key>"
