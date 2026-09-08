import { createMcpHandler, McpServer } from "@modelcontextprotocol/server"

export interface ReferenceMcpServer {
  readonly endpoint: string
  readonly stop: () => Promise<void>
}

export const startReferenceMcpServer = async (): Promise<ReferenceMcpServer> => {
  const handler = createMcpHandler(() => {
    const mcp = new McpServer({ name: "official-sdk-reference", version: "1.0.0" })
    mcp.registerTool("reference_status", {
      description: "Returns the status of the official SDK reference server."
    }, async () => ({
      content: [{ type: "text", text: "ready" }],
      structuredContent: { status: "ready", implementation: "official-sdk" }
    }))
    return mcp
  }, { legacy: "reject" })

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      if (url.pathname !== "/mcp") return new Response("not found", { status: 404 })
      return handler.fetch(request)
    }
  })

  return {
    endpoint: `http://127.0.0.1:${server.port}/mcp`,
    stop: async () => {
      server.stop(true)
      await handler.close()
    }
  }
}
