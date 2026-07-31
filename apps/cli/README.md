# @mokronos/wf

The globally installable `wf` command, durable background service, and local dashboard.

```sh
bun install --global @mokronos/wf
wf install
wf web
```

The npm package installs a standalone platform binary. Bun is not required on the user's machine.
Workflow state is stored in `~/.wf` by default; set `WF_HOME` to override it.

Integration discovery and execution use Executor for both MCP and OpenAPI:

```sh
wf integrations discover https://mcp.example.com/mcp
wf integrations connect <integration-slug>
wf integrations tools <integration-slug>
wf integrations invoke <tool-address> '{"query":"status"}'
```

The default connection is named `default`. Use `--json` on `discover` or `tools`
when an agent needs complete schemas or machine-readable output. `discover`
performs URL detection, auth discovery, registration, and tool discovery. For
OAuth, `connect` opens a browser and returns through a loopback callback.
Credentials are AES-GCM encrypted with a separate user-only key; workflows
persist only the Executor tool address.

`wf install` currently registers a per-user service on Linux and macOS. Windows
service registration is not implemented yet.
