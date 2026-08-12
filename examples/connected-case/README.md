# Connected case workflow

This workflow demonstrates an Executor-backed integration graph. It combines:

- three operations discovered from an OpenAPI document;
- one MCP tool;
- parallel durable steps, retries, deterministic time, and a named code transform;
- a durable human approval that resumes in another process;
- an OpenAPI write after approval.

Each integration step names only an integration slug and a tool name. It does not
name a connection, so this file is shareable as-is: the connection is resolved
from whatever the running machine has, at the moment the step runs.

`ApproveCase` additionally pins `owner: "org"`, because an approval audit belongs
to the team's shared credential rather than to whoever happened to connect their
own account. A pinned tier is a constraint, not a preference — if only a `user`
connection exists, the step fails instead of filing the audit under one person.

Discovery and credentials stay outside the authored workflow:

```bash
wf i discover <mcp-or-openapi-url>
wf i connect <integration-slug> --connection default
wf i tools <integration-slug> --connection default
wf i schema <integration-slug> <tool-name>
```

To find out what this workflow still needs on your machine, ask it:

```bash
wf validate --file workflow.ts
```

That traces the workflow, lists every integration it reaches, and reports each
one as ready or with the command that fixes it. It exits nonzero while anything
is unconnected, so it works as a gate before `wf run`.

The integration slugs are fixed as `crm` and `case_review`, so the workflow has
the same meaning wherever it runs. Install those integrations under the declared
slugs rather than selecting workflow identity through process environment.

The CLI delegates protocol detection, auth templates, OAuth, connection metadata,
tool schemas, and invocation to Executor.
