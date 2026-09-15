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

The packages are not on npm yet. Install from this repository with Bun 1.2 or
newer:

```bash
git clone https://github.com/mokronos/integrations.git
cd integrations
bun install
bun run install:local
ii login
```

`install:local` puts `i` and `ii` on PATH as shims that run the TypeScript
sources in the checkout, so there is no build step and `git pull && bun install`
is the whole upgrade. Keep the checkout where it is; moving it means re-running
`bun run install:local`. The gateway dashboard is the one part that needs
building — run `bun run build:control-plane` before `ii serve` if you want it.

`i` mirrors the public TypeScript client: agents can discover integrations,
manage connections, inspect schemas, invoke effective policy tools, and poll their own
approvals. `ii` is its strict operator superset, adding every dashboard action,
human login/account commands, and local gateway lifecycle commands.

State defaults to `~/.integrations`; set `INTEGRATIONS_HOME` to use another
directory.

## Development

```bash
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
gateway API key as a bearer token. The server exposes only that client's
effective tools. Tool names use `<connection-alias>__<tool-name>` so tools from
multiple enabled connections remain distinct. A connection alias spells out the
whole reference — `org--github--work`, or `user--sebastian--github--work` for a
connection held on one person's behalf — so no two connections can share one.
