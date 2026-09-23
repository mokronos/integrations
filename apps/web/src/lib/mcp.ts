export const gatewayServerName = "integrations"

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
      [gatewayServerName]: { type: "http", url }
    }
  }, null, 2)

const apiKeyEnvVar = "INTEGRATIONS_API_KEY"

export type CodingAgent = "claude" | "codex" | "opencode"

export interface Snippet {
  readonly label: string
  readonly value: string
}

export interface AgentSetup {
  readonly browserLogin: ReadonlyArray<Snippet>
  readonly browserLoginHint: string
  readonly apiKey: Snippet
}

interface OpenCodeRemoteServer {
  readonly url: string
  readonly oauth?: false
  readonly headers?: Readonly<Record<string, string>>
}

const openCodeConfiguration = (name: string, server: OpenCodeRemoteServer): string =>
  JSON.stringify({ $schema: "https://opencode.ai/config.json", mcp: { [name]: { type: "remote", ...server } } }, null, 2)

export const agentSetup = (
  agent: CodingAgent,
  clientName: string,
  url: string,
  apiKey: string
): AgentSetup => {
  const keyed = mcpServerName(clientName)
  switch (agent) {
    case "claude":
      return {
        browserLogin: [{ label: "Claude Code command", value: `claude mcp add --transport http ${gatewayServerName} ${url}` }],
        browserLoginHint: "Then run /mcp in Claude Code and choose Authenticate.",
        apiKey: { label: "Claude Code API key command", value: `claude mcp add --transport http ${keyed} ${url} --header "Authorization: Bearer ${apiKey}"` }
      }
    case "codex":
      return {
        browserLogin: [{ label: "Codex commands", value: `codex mcp add ${gatewayServerName} --url ${url}\ncodex mcp login ${gatewayServerName}` }],
        browserLoginHint: "The login command opens your browser.",
        apiKey: { label: "Codex API key commands", value: `export ${apiKeyEnvVar}=${JSON.stringify(apiKey)}\ncodex mcp add ${keyed} --url ${url} --bearer-token-env-var ${apiKeyEnvVar}` }
      }
    case "opencode":
      return {
        browserLogin: [
          { label: "opencode.json", value: openCodeConfiguration(gatewayServerName, { url }) },
          { label: "OpenCode login command", value: `opencode mcp auth ${gatewayServerName}` }
        ],
        browserLoginHint: "Add the server to opencode.json, then log in from your terminal.",
        apiKey: { label: "opencode.json with API key", value: openCodeConfiguration(keyed, { url, oauth: false, headers: { Authorization: `Bearer ${apiKey}` } }) }
      }
  }
}
