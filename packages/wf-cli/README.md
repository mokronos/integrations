# @mokronos/wf

The globally installable `wf` command, durable background service, and local dashboard.

```sh
bun install --global @mokronos/wf
wf install
wf web
```

The npm package installs a standalone platform binary. Bun is not required on the user's machine.
Workflow state is stored in `~/.wf` by default; set `WF_HOME` to override it.

The integration commands are designed for coding agents and avoid manual token
copying when an MCP server advertises standard OAuth metadata:

```sh
wf integrations search linear --kind mcp
wf integrations show linear.app
wf integrations connect linear.app --scopes read
wf integrations inspect-mcp linear.app --connection linear_oauth_app --json
```

`connect` opens a browser for consent and returns through a loopback callback.
Credentials are encrypted locally and workflows persist only an `auth(...)`
reference.

`wf install` currently registers a per-user service on Linux and macOS. Windows
service registration is not implemented yet.
