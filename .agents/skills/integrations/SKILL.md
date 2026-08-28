---
name: integrations
description: Use the `i` (integrations) CLI to find, connect, and call external APIs and MCP servers through the local gateway. Use when you need a tool from an outside service (Linear, GitHub, Gmail, Slack, any OpenAPI/MCP endpoint) and don't already have a working call for it.
---

# integrations (`i`)

`i` is a thin client over a local **gateway** that holds every connection and
credential. Nothing else sees a credential. `i` and `integrations` are the same
command.

Commands print complete JSON — every row, every field; `-v` pretty-prints.
Narrow with `--filter` on `tools`, `--limit`/`--offset` on any listing, or a
pipe into `jq`.

## Quickstart

```bash
i search linear                              # 1. find the integration's discovery URL
i discover https://mcp.linear.app/mcp        # 2. register it; returns slug, tools, auth templates
i connect mcp_linear_app                     # 3. authorize (OAuth opens a browser)

i tools mcp_linear_app --filter issue        # browse tool names
i schema mcp_linear_app list_issues          # read one tool's input/output schema
                                             # and its canonical tools.… address

i execute mcp-linear-app list_issues '{"limit":5}' # 4. call it after connect
```

OAuth requires a human browser step. Run `i connect` with a command timeout of
at least 5 minutes; do not let the agent's shell timeout terminate it first.

`i connect` grants every currently available tool from that connection to the
connecting agent's key. Its execution alias is the integration slug with
non-alphanumeric separators changed to dashes, so `mcp_linear_app` becomes
`mcp-linear-app`. These grants allow calls without a second human approval.
Use `i grants` to inspect the exact alias and tools.

Every call answers in one shape: `{"status":"succeeded","result":…}`,
`{"status":"pending","approvalId":…}`, `{"status":"denied","reason":…}`, or
`{"status":"failed","message":…}`. `pending` means a human has to decide: poll
`i approval <id>`, or just run the same call again — a retry meets the same
frozen call rather than asking again, and collects the decision once it lands.

## Rules

- Start from `search`/`discover`, never guess a URL, address, tool name, or
  schema. Addresses especially: `integration/tool` and a bare
  `tools.<integration>.<tool>` both fail — the owner and connection parts are
  required.
- Read `schema` for the one tool you settled on before calling it — don't dump
  every schema.

## Everything else

```bash
i --help
i <subcommand> --help
```
