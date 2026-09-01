/** The configuration block an MCP client wants, written once.
 *
 *  Two places offer it — the client's MCP card, and the dialog that shows a
 *  freshly issued key — and they differ only in whether the real secret is
 *  available to put in it. Sharing the shape keeps a copy taken at one of them
 *  from being subtly unlike a copy taken at the other. */
export const mcpConfiguration = (
  clientName: string,
  url: string,
  /** The plaintext key when one is in hand; otherwise a placeholder for the
   *  operator to replace, since the gateway keeps only the hash. */
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

/** What stands in for a key that cannot be shown again. */
export const apiKeyPlaceholder = "<api-key>"
