/**
 * A throwaway upstream MCP server for manual testing: one `echo` tool, no auth.
 * Prints every traceparent it receives, so a run shows whether the gateway propagated the trace.
 *
 *   bun run scripts/fixture-mcp.ts [port]
 */
import { createMcpHandler, fromJsonSchema, McpServer } from "@modelcontextprotocol/server"

const port = Number(process.argv[2] ?? 47_912)

const handler = createMcpHandler(() => {
  const server = new McpServer({ name: "fixture", version: "0.0.0" })
  server.registerTool(
    "echo",
    {
      description: "Returns the text it was given",
      inputSchema: fromJsonSchema<{ readonly text?: string }>({
        type: "object",
        properties: { text: { type: "string" } }
      })
    },
    async ({ text }) => ({ content: [{ type: "text", text: text ?? "pong" }] })
  )
  return server
})

Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch: (request) => {
    const traceparent = request.headers.get("traceparent")
    if (traceparent !== null) console.log(`traceparent ${traceparent}`)
    return handler.fetch(request)
  }
})
console.log(`fixture MCP server at http://127.0.0.1:${port}/mcp`)
