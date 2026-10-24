/**
 * A throwaway upstream MCP server for manual testing, no auth: `echo`;
 * `greet`, which asks for a name in an `input_required` round first; and
 * `weather`, which declares an output schema, returns structured content and
 * an image, and renders in an MCP App view. It also serves a plain resource
 * and one skill.
 * Prints every traceparent it receives, so a run shows whether the gateway propagated the trace.
 *
 *   bun run scripts/fixture-mcp.ts [port]
 */
import { createMcpHandler, fromJsonSchema, inputRequired, inputResponse, McpServer } from "@modelcontextprotocol/server"
import { memorySkillFiles, SkillsExtension } from "@modelcontextprotocol/server/ext/skills"

const port = Number(process.argv[2] ?? 47_912)

/** A 1×1 PNG, enough to show an image travels as an image. */
const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

/**
 * The view `weather` renders in: speaks the MCP Apps postMessage protocol by
 * hand, shows the result it is given, and can call `echo` and tell the model
 * something through its host.
 */
const weatherView = `<!doctype html>
<html><head><meta charset="utf-8"><title>Weather</title>
<style>body{font-family:system-ui,sans-serif;margin:16px;color:#111}button{margin-right:8px}#forecast{font-size:28px;margin:8px 0}</style>
</head><body>
<h2>Fixture weather</h2>
<div id="forecast">waiting for the result…</div>
<button id="echo">Ask echo from the view</button>
<button id="tell">Tell the agent</button>
<pre id="log"></pre>
<script>
let next = 1; const pending = new Map();
const log = (line) => { document.getElementById("log").textContent += line + "\\n" };
const request = (method, params) => new Promise((resolve) => { const id = next++; pending.set(id, resolve); parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*") });
addEventListener("message", (event) => {
  const message = event.data;
  if (message && message.id !== undefined && pending.has(message.id)) { pending.get(message.id)(message.result ?? message.error); pending.delete(message.id); return }
  if (message && message.method === "ui/notifications/tool-result") {
    const weather = message.params.structuredContent;
    document.getElementById("forecast").textContent = weather.city + ": " + weather.temperature + "°C, " + weather.sky;
  }
  if (message && message.method === "ui/notifications/tool-input") log("input " + JSON.stringify(message.params.arguments));
});
request("ui/initialize", { appInfo: { name: "fixture-weather", version: "0.0.0" }, appCapabilities: {}, protocolVersion: "2026-01-26" }).then(() => {
  parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} }, "*");
  log("initialized");
});
document.getElementById("echo").onclick = async () => {
  const result = await request("tools/call", { name: "echo", arguments: { text: "from the view" } });
  log("echo said " + JSON.stringify(result.structuredContent ?? result.content));
};
document.getElementById("tell").onclick = async () => {
  await request("ui/update-model-context", { structuredContent: { picked: "umbrella" } });
  await request("ui/message", { role: "user", content: [{ type: "text", text: "Bring an umbrella." }] });
  log("told the agent");
};
</script></body></html>`

const skills = await SkillsExtension.load(
  memorySkillFiles({
    "fixture-howto/SKILL.md":
      "---\nname: fixture-howto\ndescription: How to use the fixture server's tools.\n---\n\nCall echo with text; call weather with a city.\n"
  })
)

const handler = createMcpHandler(() => {
  const server = new McpServer(
    { name: "fixture", version: "0.0.0" },
    { instructions: "A fixture server for testing the gateway." }
  )
  skills.attach(server)
  server.registerResource(
    "weather-view",
    "ui://fixture/weather.html",
    { mimeType: "text/html;profile=mcp-app", description: "The view weather renders in" },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/html;profile=mcp-app",
          text: weatherView,
          _meta: { ui: { prefersBorder: true } }
        }
      ]
    })
  )
  server.registerResource(
    "note",
    "fixture://notes/1",
    { mimeType: "text/plain", description: "A note" },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/plain", text: "remember the milk" }]
    })
  )
  server.registerTool(
    "weather",
    {
      title: "Weather forecast",
      description: "Today's weather for a city, with a picture of the sky",
      inputSchema: fromJsonSchema<{ readonly city?: string }>({
        type: "object",
        properties: { city: { type: "string" } }
      }),
      outputSchema: fromJsonSchema<{ readonly city: string; readonly temperature: number; readonly sky: string }>({
        type: "object",
        properties: { city: { type: "string" }, temperature: { type: "number" }, sky: { type: "string" } },
        required: ["city", "temperature", "sky"]
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: { ui: { resourceUri: "ui://fixture/weather.html" } }
    },
    async ({ city }) => {
      const weather = { city: city ?? "Berlin", temperature: 21, sky: "clear" }
      return {
        content: [
          { type: "text", text: JSON.stringify(weather) },
          { type: "image", data: pixel, mimeType: "image/png" }
        ],
        structuredContent: weather
      }
    }
  )
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
  server.registerTool(
    "greet",
    {
      description: "Greets whoever answers the name it asks for",
      inputSchema: fromJsonSchema<Record<string, never>>({ type: "object", properties: {} })
    },
    async (_arguments, context) => {
      const answer = inputResponse(context.mcpReq.inputResponses, "name")
      if (answer.kind !== "elicit") {
        return inputRequired({
          inputRequests: {
            name: inputRequired.elicit({
              message: "What is your name?",
              requestedSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] }
            })
          }
        })
      }
      const name = answer.action === "accept" ? String(answer.content?.["name"]) : "stranger"
      return { content: [{ type: "text", text: `hello ${name}` }] }
    }
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
