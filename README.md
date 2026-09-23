# integrations

`integrations` is an agent-facing gateway for discovering external APIs,
holding their credentials, assigning reusable tool policies to clients, and
executing calls under policy.

The gateway is the only component that sees credentials. Clients receive an API
key and invoke logical `{ alias, tool }` addresses through the HTTP API.

## Quickstart

Install from GitHub and start the local gateway:

```bash
curl -fsSL https://raw.githubusercontent.com/mokronos/integrations/main/install.sh | sh
ii install
```

Add the integrations skill globally to your agent:

```bash
npx skills add https://github.com/mokronos/integrations/tree/main/.agents/skills/integrations -g
```

Start a new agent session and ask it to use an integration. For example:

```bash
Check my open linear issues
```

The skill teaches the agent to discover, connect, inspect, and call integrations
directly with `i`.

## Gateway and dashboard

`i` is a client for the gateway, so a gateway must be running. `ii install`
registers and starts the local gateway as a per-user service on Linux or macOS.
Use `ii serve -d` instead to run it only for the current session. A separately
hosted gateway can be used instead by setting `INTEGRATIONS_URL` and
`INTEGRATIONS_API_KEY`.

Open the optional control plane with:

```bash
ii dashboard
```

The installer requires curl and tar. It downloads the latest standalone binary
for Linux or macOS, verifies its SHA-256 checksum, and installs `i` and `ii`
under `~/.local/bin`. Git, Bun, npm, and a source checkout are not required.
Override the destination with `INTEGRATIONS_BIN_DIR`.

Re-run the same command to upgrade. To pin a release:

```bash
curl -fsSL https://raw.githubusercontent.com/mokronos/integrations/main/install.sh \
  | sh -s -- --version v0.2.0
```

`i` mirrors the public TypeScript client: agents can discover integrations,
manage connections, inspect schemas, invoke effective policy tools, and poll
their own approvals. `ii` is its strict operator superset, adding every
dashboard action, human login/account commands, and local gateway lifecycle
commands.

The local gateway creates separate credentials for these commands. `i` reads
the agent key from `~/.integrations/gateway.json`; it can provision connections
but cannot administer clients or keys. Without a saved operator session, `ii`
reads its administrator key from `~/.integrations/operator-gateway.json`.
For a remote gateway, configure `INTEGRATIONS_URL` and `INTEGRATIONS_API_KEY`
for `i`, or `INTEGRATIONS_URL` and `INTEGRATIONS_ADMIN_API_KEY` for `ii`.

State defaults to `~/.integrations`; set `INTEGRATIONS_HOME` to use another
directory.

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
| `apps/platform-demo/` | An application embedding the gateway core in-process, on its own database |
| `packages/integrations/` | The integration host: MCP and OpenAPI catalog, connections, tools |
| `packages/contracts/` | Shared vocabulary and wire contracts |

`VISION.md` records product direction.

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

## Packages

The libraries are published to GitHub Packages under the `@mokronos` scope:
`integrations-contracts`, `integrations-observability`, `integrations-host`,
`integrations-gateway-core`, `integrations-gateway-api` and
`integrations-client`. One release publishes all six under the same version, so
they are installed as a set.

GitHub Packages authenticates every read, a public one included, so a consumer
needs a token with the `read:packages` scope and an `.npmrc` beside its
manifest:

```
@mokronos:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

```bash
bun add @mokronos/integrations-gateway-core
```

Nightlies are published under the `nightly` dist-tag and never become `latest`,
so `bun add @mokronos/integrations-client@nightly` is the only way to reach
one. Every release also attaches the packed tarballs and their checksums to the
GitHub release, which is what to read when a published version has to be
audited or mirrored.

## Embedding

An application that owns its process and database does not need the HTTP
API to reach the gateway. `gatewayCoreLayer` from
`@mokronos/integrations-gateway-core` provides the store, the integration
host, and OAuth sessions as Effect services on whatever `SqlClient` the
application supplies. From there `listEffectiveTools` returns an agent's tools
with schemas and `invokeAsClient` executes under the same policy, approval,
and audit path the `/v1/execute` route uses. The core and the host export
their Drizzle schemas under `./schema`, so the application's migration
pipeline can carry the gateway's tables; pass `migrate: false` and the gateway
trusts the tables are there. `apps/platform-demo/` is the smallest working
example.

The packages to embed are `@mokronos/integrations-contracts`,
`@mokronos/integrations-host` and `@mokronos/integrations-gateway-core`. They
run on Node or Bun and declare `effect`, `@effect/sql-libsql`, `drizzle-orm`
and `@libsql/client` as peer dependencies, so the application holds the one
copy of each. Pass `publicUrlOf` and serve `GET /v1/oauth/callback` yourself;
without a public URL, OAuth needs the loopback authorizer that only the Bun
host in `@mokronos/integrations-gateway-api` provides.

## Delegated access

A tool can act for the person the agent is serving rather than for the
organisation. The administrator grants it on a delegation template: a
user-owned connection with no subject, so its alias reads `user___gmail___work`
rather than naming anyone. Every invocation of such a tool names a subject,
the gateway's id for that person, which an administrator mirrors from the
application's own users through `POST /v1/subjects`.

The first call for a subject who has not connected yet does not fail. The
gateway starts the OAuth flow bound to that subject and answers
`authorization-required` with the session, including the URL to open. The
application shows it to the person, the provider redirects to the gateway's
callback, and the connection lands under `user:<subject>`. The same call then
runs. Because the binding happens when the flow starts, a leaked URL can only
ever finish that person's connection, never someone else's.

## Clients

The TypeScript client communicates only with the versioned gateway HTTP API.
Applications such as [`wf`](https://github.com/mokronos/wf) consume the client
without importing gateway or integrations implementation.

MCP clients connect to the Streamable HTTP endpoint at `/mcp` and send their
gateway API key as a bearer token. What the server advertises depends on the
client's MCP surface, set in the dashboard.

With the `tools` surface the server exposes that client's tools under
`<connection-alias>__<tool-name>`, so tools from multiple enabled connections
remain distinct. A connection alias spells out the whole reference —
`org___github___work`, or `user___sebastian___github___work` for a connection
held on one person's behalf — so no two connections can share one.

With the `discovery` surface it instead offers the `i` CLI's own commands as
tools: `search`, `discover`, `integrations`, `connect`, `oauth_status`,
`connections`, `disconnect`, `tools`, `schema`, `execute`, `validate`, and
`approval`. An agent that speaks MCP can therefore find an integration,
authorize it, and call it without a terminal. The provisioning ones appear only
for keys that hold `provision_connections`. Each runs the same gateway operation
the matching HTTP route runs, so the two surfaces cannot drift apart.

Two things stay CLI-only for now: a tool result carrying a blob handle comes
back as the handle rather than the bytes, and local file arguments are refused
instead of uploaded. Both say so in the result.
