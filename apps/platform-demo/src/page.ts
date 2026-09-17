import type { InvocationOutcome, Json } from "@integrations/contracts"
import type { EffectiveTool } from "@integrations/gateway-core"

export interface AgentView {
  readonly id: string
  readonly name: string
  readonly clientId: string
  readonly tools: ReadonlyArray<EffectiveTool>
}

export interface PageModel {
  readonly agents: ReadonlyArray<AgentView>
  readonly selected: string | undefined
  readonly integrations: ReadonlyArray<string>
  readonly result: InvocationOutcome | undefined
}

const escape = (text: string): string =>
  text.replace(/[&<>"']/g, (character) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character] ?? character)

const json = (value: Json): string => escape(JSON.stringify(value, null, 2))

const toolRow = (tool: EffectiveTool, withSchema: boolean): string => `
  <tr>
    <td><code>${escape(tool.alias)}</code></td>
    <td><code>${escape(tool.tool)}</code></td>
    <td>${escape(tool.decision)}</td>
    <td>${withSchema && tool.inputSchema !== undefined ? `<details><summary>schema</summary><pre>${json(tool.inputSchema)}</pre></details>` : ""}</td>
  </tr>`

const agentSection = (agent: AgentView, selected: boolean): string => `
  <section>
    <h3>${escape(agent.name)} <small>gateway client <code>${escape(agent.clientId)}</code></small>
      ${selected ? "" : `<a href="/?agent=${encodeURIComponent(agent.id)}">show schemas</a>`}</h3>
    <table>
      <thead><tr><th>alias</th><th>tool</th><th>policy</th><th></th></tr></thead>
      <tbody>${agent.tools.map((tool) => toolRow(tool, selected)).join("")}</tbody>
    </table>
    <form method="post" action="/execute?agent=${encodeURIComponent(agent.id)}">
      <input type="hidden" name="agent" value="${escape(agent.id)}">
      <input name="alias" placeholder="alias" required>
      <input name="tool" placeholder="tool" required>
      <input name="arguments" placeholder='{"id": 1}' size="40">
      <button>execute in-process</button>
    </form>
  </section>`

export const page = (model: PageModel): string => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>platform demo</title>
  <style>
    body { font: 15px/1.4 system-ui, sans-serif; max-width: 60rem; margin: 2rem auto; padding: 0 1rem; }
    table { border-collapse: collapse; width: 100%; }
    td, th { text-align: left; padding: .25rem .5rem; border-bottom: 1px solid #ddd; vertical-align: top; }
    pre { background: #f6f6f6; padding: .5rem; overflow: auto; max-height: 20rem; }
    form { display: flex; gap: .5rem; flex-wrap: wrap; margin: .5rem 0; }
    section { margin: 2rem 0; }
  </style>
</head>
<body>
  <h1>platform demo</h1>
  <p>One process, one database. Agents are rows in the platform's <code>agent</code> table; each holds a
  gateway client. Tools and execution come from the gateway core called directly, not over HTTP.</p>

  <section>
    <h2>Integrations <small>${model.integrations.map((slug) => `<code>${escape(slug)}</code>`).join(" ")}</small></h2>
    <form method="post" action="/integrations${model.selected === undefined ? "" : `?agent=${encodeURIComponent(model.selected)}`}">
      <input name="spec" placeholder="https://petstore3.swagger.io/api/v3/openapi.json" size="50" required>
      <input name="slug" placeholder="petstore" required>
      <input name="template" placeholder="auth template (none)">
      <input name="token" placeholder="token, if the template needs one">
      <button>add OpenAPI integration</button>
    </form>
  </section>

  <section>
    <h2>Agents</h2>
    <form method="post" action="/agents">
      <input name="name" placeholder="support-agent" required>
      <button>create agent</button>
    </form>
  </section>

  ${model.result === undefined ? "" : `<section><h2>Last execution</h2><pre>${escape(JSON.stringify(model.result, null, 2))}</pre></section>`}

  ${model.agents.map((agent) => agentSection(agent, agent.id === model.selected)).join("")}
</body>
</html>`
