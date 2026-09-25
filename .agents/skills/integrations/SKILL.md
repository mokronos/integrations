---
name: integrations
description: Use the `i` (integrations) CLI to find, connect, and call external APIs and MCP servers. Use when you need a tool from an outside service (Linear, GitHub, Gmail, Slack, any OpenAPI/MCP endpoint) and don't already have a working call for it.
---

# integrations (`i`)

`i` is a thin client over a local **gateway** that holds every connection and
credential. Nothing else sees a credential. `i` and `integrations` are the same
command.

Commands print compact JSON with every row needed for the next step. `-v`
includes the complete objects and pretty-prints them. Narrow with `--filter` on
`tools`, `--limit`/`--offset` on any listing, or a pipe into `jq`.

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

Keep the exact integration `slug` returned by `integrations` or `discover`. In
the fresh Linear example above it is `mcp_linear_app`; an existing Linear
integration may use a different slug. Then call whatever tool you want:

```bash
i tools mcp_linear_app --filter list_issues
# Copy the returned `next`; one matching row makes it a concrete schema command.
```

Use the exact `next` command returned by `tools` to inspect the schema. Then use
the exact `next` command returned by `schema` to execute it with the arguments
you need. `schema` and `execute` take the same two identifiers: the connection
alias that `tools` printed, then the tool name. The integration slug is only
for `tools`, `connect`, and `discover`.

OAuth requires a human browser step. Run `i connect` with a command timeout of
at least 5 minutes; do not let the agent's shell timeout terminate it first.

`i connect` binds every currently available tool from that connection to the
connecting client and adds it to the tenant's default policy. Safe tools run
directly; mutating or unclassified tools ask a human.

`i execute` takes an **alias**, not an integration slug. An alias names one
connection uniquely — `org_statelessserver_default` — because a slug does not:
the same integration can be connected twice, and a personal connection also
carries whose it is. Do not construct one. Read it from the matching `i tools`
row or use that response's concrete `next` command. A slug passed to `i schema`
or `i execute` is not an alias and will not resolve to the connection.

Every `execute` call answers in one shape: `{"status":"succeeded","result":…}`,
`{"status":"pending","approvalId":…}`, `{"status":"denied","reason":…}`, or
`{"status":"failed","message":…}`. `pending` means a human has to decide.
If you need to wait for approval, poll `i approval <id>` every 60 seconds and sleep in between.
Afterwards or alternatively just run the same `i execute` call again — a retry meets the same frozen call rather than asking again, and collects the decision once it lands.

If a command says the gateway is unavailable, retry that exact command once.
If it still fails, report that the gateway is down; do not reinterpret it as a
protocol mismatch or inspect the CLI source code.

## Rules

- Never construct an alias. Read it from `i tools` or use its `next` command.
- Start from `search`/`discover`, never guess a URL, address, tool name, or
  schema. Addresses especially: `integration/tool` and a bare
  `tools.<integration>.<tool>` both fail — the owner and connection parts are
  required.
- Read `schema` for the one tool you settled on before calling it — don't dump
  every schema.

## Composition

When you have a task, that involves multiple steps that don't require you to look at the intermediate results, try to check the schemas of all required tools first in parallel, then compose the rest of the task with the available tools, instead of calling each tool after each other.

## Everything else

```bash
i --help
i <subcommand> --help
```
