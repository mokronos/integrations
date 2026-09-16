# integrations

`integrations` is an agent-facing gateway for discovering external APIs,
holding their credentials, assigning reusable tool policies to clients, and
executing calls under policy.

The gateway is the only component that sees credentials. Clients receive an API
key and invoke logical `{ alias, tool }` addresses through the HTTP API.

## Surfaces

| Path | Purpose |
| --- | --- |
| `packages/core/gateway/` | Gateway domain, persistence, policy, and execution |
| `packages/core/api/` | Typed HTTP API, handlers, and server assembly |
| `apps/local/` | Local Bun host and service lifecycle |
| `apps/cli/` | `i` delegated client CLI and `ii` operator CLI |
| `apps/ts/` | `@mokronos/integrations-client`, the thin TypeScript gateway client |
| `apps/web/` | Browser control plane |
| `apps/host-cloudflare/` | Cloudflare Worker host |
| `packages/integrations/` | The integration host: MCP and OpenAPI catalog, connections, tools |
| `packages/contracts/` | Shared vocabulary and wire contracts |

`VISION.md` records product direction.

## Install

Install the latest GitHub release with curl, Git, and Bun 1.2 or newer:

```bash
curl -fsSL https://github.com/mokronos/integrations/releases/latest/download/install.sh | sh
ii install
ii dashboard
```

`ii install` registers the gateway as a per-user service on Linux or macOS. Use
`ii serve -d` instead to run it for the current session. The installer checks
out the release under `~/.local/share/integrations`, builds the control plane,
and puts `i` and `ii` on PATH. Override those locations with
`INTEGRATIONS_INSTALL_DIR` and `INTEGRATIONS_BIN_DIR`.

To install the current development branch instead of a release:

```bash
curl -fsSL https://raw.githubusercontent.com/mokronos/integrations/main/install.sh | sh
```

Re-run the same command to upgrade. The installer refuses to overwrite local
changes in its checkout.

`i` mirrors the public TypeScript client: agents can discover integrations,
manage connections, inspect schemas, invoke effective policy tools, and poll their own
approvals. `ii` is its strict operator superset, adding every dashboard action,
human login/account commands, and local gateway lifecycle commands.

State defaults to `~/.integrations`; set `INTEGRATIONS_HOME` to use another
directory.

## Development

```bash
git clone https://github.com/mokronos/integrations.git
cd integrations
bun install
bun run typecheck
bun test
bun run build
bun run build:control-plane
```

Run the CLIs from source with:

```bash
bun run apps/cli/src/agent.ts --help
bun run apps/cli/src/main.ts serve
```

Install this checkout's source-backed `i` and `ii` commands with:

```bash
bun run install:local
```

The shims run the TypeScript sources directly. Keep the checkout where it is;
moving it means re-running `bun run install:local`.

After changing sources, hand the machine to the working tree in one step:

```bash
bun run refresh
```

That reinstalls the `i` and `ii` shims, stops the gateway that is running —
service unit or a `serve` started by hand — and starts one from these sources on
the same port. A gateway keeps the modules Bun loaded at startup, so one left
running across a change serves the older wire shape to newly started clients.

## Clients

The TypeScript client communicates only with the versioned gateway HTTP API.
Applications such as [`wf`](https://github.com/mokronos/wf) consume the client
without importing gateway or integrations implementation.

MCP clients connect to the Streamable HTTP endpoint at `/mcp` and send their
gateway API key as a bearer token. The server exposes that client's effective
tools under `<connection-alias>__<tool-name>`, so tools from multiple enabled
connections remain distinct. A connection alias spells out the whole reference —
`org_github_work`, or `user_sebastian_github_work` for a connection held on one
person's behalf — so no two connections can share one.

Alongside them it offers the `i` CLI's own commands as tools: `search`,
`discover`, `integrations`, `rename`, `connect`, `oauth_status`, `connections`,
`disconnect`, `tools`, `schema`, `execute`, `validate`, and `approval`. An agent
that speaks MCP can therefore find an integration, authorize it, and call it
without a terminal. The provisioning ones appear only for keys that hold
`provision_connections`. Each is served by calling the same HTTP route the CLI
calls, so the two surfaces cannot drift apart.

Two things stay CLI-only for now: a tool result carrying a blob handle comes
back as the handle rather than the bytes, and local file arguments are refused
instead of uploaded. Both say so in the result.
