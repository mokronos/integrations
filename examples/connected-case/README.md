# Connected case workflow

This workflow demonstrates an Executor-backed integration graph. It combines:

- three operations discovered from an OpenAPI document;
- one MCP tool;
- parallel durable steps, retries, deterministic time, and a named code transform;
- a durable human approval that resumes in another process;
- an OpenAPI write after approval.

Each integration step names only an alias and a tool name. It does not name a
connection, so this file is shareable as-is: a grant resolves each alias to the
connection available on the machine that runs it.

`ApproveCase` uses the `case-review` alias. Its deployment must bind that alias
to the team's shared connection; the workflow cannot and should not choose an
owner tier or connection name.

Discovery and credentials stay outside the authored workflow:

```bash
integrations discover <mcp-or-openapi-url>
integrations connect <integration-slug>
integrations tools <integration-slug>
integrations schema <integration-slug> <tool-name>
```

To find out what this workflow still needs on your machine, ask it:

```bash
wf validate --file workflow.ts
```

That traces the workflow, lists every integration it reaches, and reports each
one as ready or with the command that fixes it. It exits nonzero while anything
is unconnected, so it works as a gate before `wf run`.

The workflow's aliases are `crm` and `case-review`. Create grants for those
aliases after connecting the relevant integrations; the integration slugs and
connection names are deployment details.

The CLI delegates protocol detection, auth templates, OAuth, connection metadata,
tool schemas, and invocation to Executor.
