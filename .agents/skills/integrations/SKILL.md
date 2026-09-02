---
name: integrations
description: Use the `i` (integrations) CLI to find, connect, and call external APIs and MCP servers. Use when you need a tool from an outside service (Linear, GitHub, Gmail, Slack, any OpenAPI/MCP endpoint) and don't already have a working call for it.
---

# integrations (`i`)

`i` is a thin client over a local **gateway** that holds every connection and
credential. Nothing else sees a credential. `i` and `integrations` are the same
command.

Commands print complete JSON — every row, every field; `-v` pretty-prints.
Narrow with `--filter` on `tools`, `--limit`/`--offset` on any listing, or a
pipe into `jq`.

## Quickstart

This is an example of a typical workflow (in this case for Linear).
Always check if the integration is already connected:

```bash
i integrations # list all integrations
```

If it isn't connected, connect it:
```bash
i search linear                              # 1. find the integration's discovery URL
i discover https://mcp.linear.app/mcp        # 2. register it; returns slug, tools, auth templates
i connect mcp_linear_app                     # 3. authorize (OAuth opens a browser)
```

Then call whatever tool you want:
```bash
i tools mcp_linear_app --filter issue        # browse tool names
i schema mcp_linear_app list_issues          # read one tool's input/output schema,
                                             # its tools.… address, and the `alias`
                                             # to call it under

i execute org--mcp-5flinear-5fapp--default list_issues '{"limit":5}' # 4. use the alias
                                                                    #    `schema` printed
```

OAuth requires a human browser step. Run `i connect` with a command timeout of
at least 5 minutes; do not let the agent's shell timeout terminate it first.

`i connect` binds every currently available tool from that connection to the
connecting client and adds it to the tenant's default policy. Safe tools run
directly; mutating or unclassified tools ask a human.

`i execute` takes an **alias**, not an integration slug. An alias names one
connection uniquely — `org--statelessserver--default` — because a slug does not:
the same integration can be connected twice, and a personal connection also
carries whose it is. Do not construct one. `i schema` reports the alias to use
in its `alias` field and in its `next` line; a slug passed to `i execute` is
denied with `not authorized for this client`, which means no alias matched, not
that the tool is missing from your policy.

Every call answers in one shape: `{"status":"succeeded","result":…}`,
`{"status":"pending","approvalId":…}`, `{"status":"denied","reason":…}`, or
`{"status":"failed","message":…}`. `pending` means a human has to decide.
If you need to wait for approval, poll `i approval <id>` every 60 seconds and sleep in between.
Afterwards or alternatively just run the same `i execute` call again — a retry meets the same frozen call rather than asking again, and collects the decision once it lands.

## Rules

- Never construct an alias. Read it from `i schema`.
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
