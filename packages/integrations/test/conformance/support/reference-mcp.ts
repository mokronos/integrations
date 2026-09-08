import { createMcpHandler, McpServer } from "@modelcontextprotocol/server"

export interface ReferenceMcpServer {
  readonly endpoint: string
  readonly stop: () => Promise<void>
}

/** A real server built from the official SDK, to check this host against.
 *
 *  `createMcpHandler` is the entry that serves protocol revision 2026-07-28 —
 *  it answers `server/discover` and mints a fresh instance per request, the
 *  revision having removed sessions from Streamable HTTP. `legacy: "reject"`
 *  turns off 2025 serving entirely, so this fixture holds the host to the one
 *  revision it claims to speak. */
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
