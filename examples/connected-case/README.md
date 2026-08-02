# Connected case workflow

This workflow demonstrates an Executor-backed integration graph. It combines:

- three operations discovered from an OpenAPI document;
- one MCP tool;
- parallel durable steps, retries, deterministic time, and a named code transform;
- a durable human approval that resumes in another process;
- an OpenAPI write after approval.

The workflow source takes Executor tool addresses from
`WF_CONNECTED_CASE_*_TOOL`. Discovery and credentials stay outside the authored
workflow:

```bash
wf i discover <mcp-or-openapi-url>
wf i connect <integration-slug> --connection default
wf i tools --integration <integration-slug> --connection default
```

The CLI delegates protocol detection, auth templates, OAuth, connection metadata,
tool schemas, and invocation to Executor.
