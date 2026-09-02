import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"

export interface ReferenceMcpServer {
  readonly endpoint: string
  readonly stop: () => Promise<void>
}

export const startReferenceMcpServer = async (): Promise<ReferenceMcpServer> => {
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>()
  const servers: Array<McpServer> = []

  const createSession = async () => {
    const mcp = new McpServer({ name: "official-sdk-reference", version: "1.0.0" })
    mcp.registerTool("reference_status", {
      description: "Returns the status of the official SDK reference server."
    }, async () => ({
      content: [{ type: "text", text: "ready" }],
      structuredContent: { status: "ready", implementation: "official-sdk" }
    }))
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (sessionId) => {
        sessions.set(sessionId, transport)
      },
      onsessionclosed: (sessionId) => {
        sessions.delete(sessionId)
      }
    })
    servers.push(mcp)
    await mcp.connect(transport)
    return transport
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      if (url.pathname !== "/mcp") return new Response("not found", { status: 404 })
      const sessionId = request.headers.get("mcp-session-id")
      const transport = sessionId === null
        ? await createSession()
        : sessions.get(sessionId)
      if (transport === undefined) return new Response("session not found", { status: 404 })
      return transport.handleRequest(request)
    }
  })

  return {
    endpoint: `http://127.0.0.1:${server.port}/mcp`,
    stop: async () => {
      server.stop(true)
      await Promise.all(servers.map((mcp) => mcp.close()))
    }
  }
}
