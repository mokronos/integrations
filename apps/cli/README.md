# @mokronos/wf

The globally installable `wf` command, durable background service, and local dashboard.

```sh
bun install --global @mokronos/wf
wf install
wf web
```

The npm package installs a standalone platform binary. Bun is not required on the user's machine.
Workflow state is stored in `~/.wf` by default; set `WF_HOME` to override it.

Command tree:

```text
wf
├── create
├── validate
├── list
├── run
├── runs
├── history (alias: events)
├── signal
├── integrations (alias: i)
│   ├── discover
│   ├── search
│   ├── list
│   ├── connect
│   ├── connections
│   ├── tools
│   ├── disconnect
│   ├── invoke
│   └── validate
├── install
├── web
└── daemon
```

Use `wf --help` or `wf <command> --help` for arguments, flags, examples, and
nested subcommands.

Integration discovery and execution use Executor for both MCP and OpenAPI:

```sh
wf i discover https://mcp.example.com/mcp
wf i search linear
wf i connect <integration-slug>
wf i tools <integration-slug>
wf i invoke <tool-address> '{"query":"status"}'
```

The default connection is named `default`. Integration commands return JSON by
default; use `--text` for human-readable output. `discover` performs URL
detection, auth discovery, registration, and tool discovery. For OAuth, `connect`
opens a browser and returns through a loopback callback.
Credentials are AES-GCM encrypted with a separate user-only key; workflows
persist only the Executor tool address.

`search` queries the public integrations.sh catalog and returns JSON enriched
with exact MCP, API, and GraphQL surface URLs. Use `--text` for a
human-readable result.

`wf install` currently registers a per-user service on Linux and macOS. Windows
service registration is not implemented yet.
