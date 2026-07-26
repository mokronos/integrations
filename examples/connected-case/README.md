# Connected case workflow

This workflow is the end-to-end agent-integration acceptance case. It combines:

- three operations discovered from an OpenAPI document;
- one OAuth-protected MCP tool;
- parallel durable steps, retries, deterministic time, and a named code transform;
- a durable human approval that resumes in another process;
- a parameter-bound JSON OpenAPI write after approval.

The workflow source stores only `auth("case_manager_oauth")`. The CLI resolves that
reference from the encrypted local connection store immediately before the MCP
call and enforces that the token is sent only to its authorized resource.

`packages/wf/test/agent-integration-flow.test.ts` starts real loopback HTTP, OAuth,
OpenAPI, and MCP fixtures, authorizes through the loopback browser callback, imports
this file through `wf create`, runs it through durable SQLite, exits at approval,
resumes it through `wf signal`, and scans persisted files for plaintext credentials.

For a real discoverable MCP service, the agent-facing sequence is:

```bash
wf integrations search linear --kind mcp
wf integrations show linear.app
wf integrations connect linear.app --scopes read
wf integrations inspect-mcp linear.app --connection linear_oauth_app --json
```

`connect` uses MCP protected-resource and authorization-server metadata, dynamic
client registration when advertised, PKCE S256, and a one-use loopback callback.
