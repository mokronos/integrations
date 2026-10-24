/** The skill this gateway serves over MCP: how to use it through its MCP tools rather than the `i` CLI. */
export const integrationsMcpSkill = `---
name: integrations-mcp
description: Use the integrations gateway's MCP tools to find, authorize, and call external services (Linear, GitHub, Gmail, Slack, any OpenAPI or MCP endpoint). Use when a task needs an outside service and this MCP server is connected.
---

# Integrations gateway over MCP

This server is a gateway. It holds every credential, and its profile decides
which tools you may call and which wait for a human. You never see a
credential, and you never approve a call yourself.

## Your tools

What you see depends on the profile:

- **Each tool on its own.** Every enabled tool is an MCP tool named
  \`<connection alias>__<tool>\`. Call it directly.
- **Discovery tools.** A fixed set that mirrors the \`i\` CLI: \`tools\` lists what
  you may call, \`schema\` shows one tool's input and output schemas, and
  \`execute\` calls it by alias and tool name. \`search\`, \`discover\`, \`connect\`,
  \`oauth_status\`, \`connections\`, \`disconnect\`, \`validate\`, and \`approval\`
  cover finding, connecting, and following up.

## Calling a tool

1. Find it: \`tools\`, narrowed with \`filter\`, \`integration\`, or \`connection\`.
2. Read its schema before the first call. The output schema describes the
   structured result you get back, so you can pass fields straight into the next
   call.
3. Call it with arguments exactly as the input schema says. When several calls
   do not depend on each other's results, read every schema first, then make
   the calls.

## When a call does not run straight away

- **Held for approval.** The result says the call waits for a human and may
  carry a link for them. Do not open it. Once they decide, call the tool again
  with the same arguments to get its result. A client that supports tasks gets a
  task to poll instead.
- **Authorization needed.** A human authorizes the service in a browser; your
  client may show them the link. Call the tool again afterwards.
- **Input needed.** The tool asks a question mid-call. Your client puts it to
  the human; answer through it.

## Files, media, and resources

Images arrive inline. Larger files and documents arrive as resource links; read
them with \`resources/read\`. The resources each connection's server offers are
listed alongside them.

## Working from a terminal

If you also have a shell, the \`i\` CLI does the same against this gateway and
writes files to disk. First check whether it is already set up: \`i whoami\`
prints the gateway and profile it uses. If \`i\` is missing, install only the
CLI:

\`\`\`bash
curl -fsSL https://raw.githubusercontent.com/mokronos/integrations/main/install.sh | sh
\`\`\`

If \`i whoami\` says no gateway is configured, log in to this gateway; its URL
is the origin of the MCP URL you reach it at:

\`\`\`bash
i login --url https://gateway.example
\`\`\`

It prints a link and a code. Ask the user to open the link, check the code, and
approve it for a profile, then run \`i login\` again to finish. Do not run
\`ii install\`: it starts a gateway of its own.
`
