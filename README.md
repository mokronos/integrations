# integrations

`integrations` is an agent-facing gateway for discovering external APIs,
holding their credentials, deciding per profile which tools an agent may call
and which calls wait for a human, and executing those calls.

The gateway is the only component that sees credentials. Each app an agent runs
in gets its own API key (or OAuth grant) for a profile and invokes logical
`{ alias, tool }` addresses through the HTTP API or MCP.

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

## Where the gateway runs

`i` is a client for the gateway, so a gateway must be running. Pick one of:

- **Local (recommended).** `ii install` registers and starts the gateway as a
  per-user service on Linux or macOS, so it survives reboots and `i` finds it
  with no configuration. Use `ii serve -d` instead to run it only for the
  current session.
- **Self-hosted.** Run the Docker image or the same binary on a server to share
  one gateway across machines or a team. See [Self-hosting](#self-hosting).
- **Embedded.** Run the gateway core in-process on your application's own
  database. See [Embedding](#embedding).

`apps/host-cloudflare/` also runs the gateway on Cloudflare Workers. It is
experimental: blobs are stored as chunked rows in the Durable Object's SQLite
until R2 is enabled, so the local and self-hosted paths are the ones to rely
on.

## Dashboard

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
manage connections, inspect schemas, invoke their profile's tools, and poll
their own approvals. `ii` is its strict operator superset, adding every
dashboard action, human login/account commands, and local gateway lifecycle
commands.

The local gateway creates separate credentials for these commands. `i` reads
the agent key from `~/.integrations/gateway.json`; it can provision connections
but cannot administer profiles or keys. Without a saved operator session, `ii`
reads its administrator key from `~/.integrations/operator-gateway.json`.
For a remote gateway, see [Self-hosting](#self-hosting).

State defaults to `~/.integrations`; set `INTEGRATIONS_HOME` to use another
directory.

## Self-hosting

A gateway bound beyond loopback takes its master key, which seals every stored
credential, only from `INTEGRATIONS_MASTER_KEY`. Keep it outside the data
directory and its backups. Put the gateway behind a TLS-terminating reverse
proxy; `INTEGRATIONS_PUBLIC_URL` is the URL users and OAuth providers reach it
at.

### Outbound requests

The gateway only fetches public HTTPS destinations on a user's behalf (OAuth
discovery and tokens, MCP servers, OpenAPI specs and calls, approval webhooks),
plus plain HTTP to loopback. Private, link-local and internal addresses are
refused, including names that resolve to them and redirects that lead to them.
To reach an internal service, list its exact origin, comma-separated, in
`INTEGRATIONS_URL_ALLOWED_ORIGINS` (for example `http://nas.lan:8080`). Set
`INTEGRATIONS_URL_ALLOW_LOOPBACK_HTTP=false` to refuse loopback too.

### Docker

```bash
cd docker
cp .env.example .env    # set INTEGRATIONS_MASTER_KEY and INTEGRATIONS_PUBLIC_URL
docker compose up -d
```

To build this checkout instead of pulling, run
`BUN_VERSION=$(cat ../.bun-version) docker compose up -d --build`.

The image is `ghcr.io/mokronos/integrations` (`latest`, `nightly`, or a
version). State lives in the `/data` volume. Probe `GET /v1/health`, or run
`ii health [--url <gateway>]`, which the image uses as its `HEALTHCHECK`.

### Binary

Install as above, then:

```bash
export INTEGRATIONS_MASTER_KEY="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"
INTEGRATIONS_PUBLIC_URL=https://integrations.example.com ii serve --host 0.0.0.0
```

### First sign-in

The first account to sign up claims the gateway, in the dashboard at the public
URL or from a client machine:

```bash
export INTEGRATIONS_URL=https://integrations.example.com
ii signup you@example.com --tenant "Your Company"
```

Create a profile with `ii profile <name>`, enable tools with
`ii profile-tool <profile-id> <integration> <tool> ask|allow`, and issue each app
its own key with `ii key <profile-id> "<app name>"`. Then on the app's machine:

```bash
export INTEGRATIONS_URL=https://integrations.example.com
export INTEGRATIONS_API_KEY=...
```

Anything other than loopback exposes the gateway, and with it every credential
it holds, to whoever can reach the port. Keep it behind TLS and a network you
trust.

## Surfaces

| Path                      | Purpose                                                                                      |
| ------------------------- | -------------------------------------------------------------------------------------------- |
| `packages/gateway-core/`  | Gateway domain, persistence, policy, and execution                                           |
| `packages/gateway-api/`   | Typed HTTP API, handlers, and server assembly                                                |
| `packages/integrations/`  | MCP and OpenAPI catalog, connections, and tool invocation                                    |
| `packages/contracts/`     | Shared vocabulary and wire contracts                                                         |
| `packages/observability/` | Trace file, console logs, and OTLP export for every process                                  |
| `apps/cli/`               | `i`, the agent CLI, and `ii`, the operator CLI that also runs the local gateway              |
| `apps/ts/`                | `@integragents/client`: what `i` does, for scripts an agent writes                           |
| `apps/web/`               | Browser control plane                                                                        |
| `apps/host-cloudflare/`   | Experimental Cloudflare host: a Worker and a SQLite Durable Object, provisioned with Alchemy |
| `apps/platform-demo/`     | An application embedding the gateway core in-process, on its own database                    |

`packages/` holds the libraries the gateway is built from; `apps/` holds what
runs against it or hosts it.

`VISION.md` records product direction.

## Development

```bash
git clone https://github.com/mokronos/integrations.git
cd integrations
bun install
bun run check          # format check, lint, typecheck, test boundary
bun run test
bun run build
bun run build:control-plane
```

`bun run format` applies the formatter (`.oxfmtrc.json`).

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

### Secrets from 1Password

Optional; a plain `.env` keeps working. Copy `.env.local.op.example` or
`.env.deploy.op.example` without the `.example` suffix, point the `op://`
references at your vault, and prefix a command with `bun run with:local` or
`bun run with:deploy`, which run it under `op run`.

### Debugging

Every gateway and CLI process appends its finished spans to
`~/.integrations/logs/{gateway,cli}.trace.ndjson`. A failed request reports its
trace id, and `jq` finds everything that request did. See
[`packages/observability/README.md`](packages/observability/README.md) for the
record shape, queries, and OTLP export.

## Packages

The packages are published to npm under the `@integragents` scope:
`contracts`, `observability`, `integrations`, `gateway-core`, `gateway-api`,
`client` and `cli`. One release publishes all of them under the same version, so
they are installed as a set.

```bash
bun add @integragents/gateway-core
```

Nightlies are published under the `nightly` dist-tag and never become `latest`,
so `bun add @integragents/client@nightly` is the only way to reach
one. Every release also attaches the packed tarballs and their checksums to the
GitHub release, which is what to read when a published version has to be
audited or mirrored.

## Embedding

An application that owns its process and database does not need the HTTP
API to reach the gateway. `gatewayCoreLayer` from
`@integragents/gateway-core` provides the store, the integration
host, and OAuth sessions as Effect services on whatever `SqlClient` the
application supplies. From there `listEffectiveTools` returns an agent's tools
with schemas and `invokeAsProfile` executes under the same decision, approval,
and audit path the `/v1/execute` route uses. The core and the host export
their Drizzle schemas under `./schema`, so the application's migration
pipeline can carry the gateway's tables; pass `migrate: false` and the gateway
trusts the tables are there. `apps/platform-demo/` is the smallest working
example.

The packages to embed are `@integragents/contracts`,
`@integragents/integrations` and `@integragents/gateway-core`. They
run on Node or Bun and declare `effect`, `@effect/sql-libsql`, `drizzle-orm`
and `@libsql/client` as peer dependencies, so the application holds the one
copy of each. Pass `publicUrlOf` and serve `GET /v1/oauth/callback` yourself;
without a public URL, OAuth needs the loopback authorizer that only the Bun
host in `@integragents/gateway-api` provides.

### Hosts that run agents durably

An application that runs agents on a durable harness, re-running a tool call
after a crash, pausing while an approval is pending, and resuming days later,
uses these parts of the embedding API. All of them come from
`@integragents/gateway-core` unless noted.

- **Idempotency keys.** `invokeAsProfile(dependencies, { ..., idempotencyKey })`
  (and `idempotencyKey` on `POST /v1/execute`, `i execute --idempotency-key`)
  names one call across its retries. The gateway keeps its outcome per tenant,
  profile and key: a repeat gets the stored outcome, or the same pending
  approval and then its decision, and never runs again. A repeat that names
  another tool or other arguments is refused as `invalid`. A keyed call gets
  its own approval, so two deliberate identical calls stay distinct; calls
  without a key are still deduplicated by their arguments. A key whose first
  call never recorded an outcome answers `failed` rather than running again.
- **Hearing about decisions.** `gatewayCoreLayer({ onApprovalDecided })` is told
  of every call that stops waiting, however it was decided: approved in the
  dashboard, over the API or in an MCP client, saved as always approve, denied,
  expired, cancelled with its profile, decided by a reviewer, or settled after
  an interrupted execution. It carries the tenant, profile, approval id, status,
  who decided, and the outcome a caller would collect. Profiles' webhook
  destinations get the same moment as a signed `approval.decided` event. The
  event bus and `/v1/events` name the approval ids that changed. The hook runs
  after the decision is stored, so a host that must not miss one also reads
  `store.listApprovals` when it starts.
- **Interrupted executions.** An approved call whose execution outlives
  `executionLease` (an hour by default) without recording a result is settled
  by maintenance as failed with an unknown outcome. It is never run again.
- **Approval expiry and subjects per profile.** A profile's
  `approvalExpiryMinutes` sets how long its calls wait; `null` waits until
  someone decides. `subjects: "any" | SubjectId[]` limits whom it may act for:
  keys are issued and logins approved only for those, and a call for anyone
  else is denied and audited.
- **Host tools.** `registerHostIntegration({ store, integrations, definition })`
  catalogs tools the host runs itself (name, description, input schema,
  `readOnly`/`destructive`/`idempotent` hints, a `handler`), on one org
  connection that holds no credential. `gatewayCoreLayer({ hostTools })` takes
  the executor (`HostTools` from `@integragents/integrations`), which receives the
  handler, arguments, and the call's tenant, profile, subject, approval and
  idempotency key. Profiles, decisions, approvals and audit treat them like
  any other tool.
- **A reviewer.** The `ApprovalReviewer` service, passed to `gatewayCoreLayer`
  (where `coreInvokeDependencies()` picks it up), as `reviewer` in
  `InvokeDependencies`, or to the HTTP handler, is asked
  about every new call that asks: `approve` runs it at once, `deny` refuses it,
  both recorded as decided by `reviewer:<name>`; `escalate`, or a failing
  reviewer, leaves it to a human.
- **Editing before approving.** `approveApproval(dependencies, { tenantId, id,
  decidedBy, arguments })` (and `POST /v1/approvals/:id/approve` with
  `{ "arguments": … }`, `ii approve --arguments`) runs replacement arguments
  once they pass the tool's input schema; the approval keeps both.
- **Tool hints.** `listEffectiveTools` reports `readOnly`, `destructive` and
  `idempotent` for each tool, from MCP annotations, the HTTP method of an
  OpenAPI operation, or a host tool's definition. Read-only tools default to
  running without asking.

```ts
const core = gatewayCoreLayer({
  encryption,
  blobs: BlobStore.sqlLayer,
  migrate: false,
  hostTools: { execute: (call) => runInSandbox(call.handler, call.arguments, call.context.subject) },
  reviewer: { name: "policy", review: (request) => judge(request) },
  onApprovalDecided: (decided) => resumeAgentWaitingOn(decided.approvalId, decided.outcome)
})

// A program running on `core`; the dependencies carry the reviewer given above.
const invoke = Effect.gen(function* () {
  return yield* invokeAsProfile(yield* coreInvokeDependencies(), {
    profile,
    origin,
    alias,
    tool,
    arguments: input,
    subject,
    idempotencyKey: IdempotencyKey.make(`${runId}/${callId}`)
  })
})
```

## Delegated access

A tool can act for the person the agent is serving rather than for the
organisation. The administrator enables it on a delegation template: a
user-owned connection with no subject, so its alias reads `user___gmail___work`
rather than naming anyone. Such a tool acts for the subject, the gateway's id
for a person, that the caller's credential belongs to; no call names one. A
login through `i login` or an MCP client belongs to whoever approved it. An API
key belongs to the subject it was issued for (`POST /v1/profiles/:id/keys` with
`subject`), which an administrator mirrors from the application's own users
through `POST /v1/subjects`. A credential without a subject does not see
delegated tools. An embedding host that identifies its users itself passes the
subject to `invokeAsProfile`.

The first call for a subject who has not connected yet does not fail. The
gateway starts the OAuth flow bound to that subject and answers
`authorization-required` with the session, including the URL to open. The
application shows it to the person, the provider redirects to the gateway's
callback, and the connection lands under `user:<subject>`. The same call then
runs. Because the binding happens when the flow starts, a leaked URL can only
ever finish that person's connection, never someone else's.

## Clients

The gateway's clients are for agents and the people supervising them, not a
developer SDK:

- `i` is how an agent discovers, connects, inspects and calls integrations from
  a shell.
- `@integragents/client` (`apps/ts/`) is the same surface for JavaScript and
  TypeScript: an agent writes a script against it when one command at a time is
  not enough, for example to chain calls or reshape their results. Tools that
  agents run, such as [`wf`](https://github.com/mokronos/wf), use it the same
  way. It speaks only the versioned HTTP API and holds no integration logic.
- `ii` is the operator's superset of `i`: dashboard actions, login and account
  commands, and the local gateway's lifecycle.

An application that wants the gateway inside its own process embeds
`gateway-core` instead; see [Embedding](#embedding).

MCP clients connect to the Streamable HTTP endpoint at `/mcp` and send their
gateway API key as a bearer token, or authorize through MCP OAuth and pick a
profile. What the server advertises depends on the profile's MCP surface, set
in the dashboard. Calls are attributed to the key or OAuth application and to
the name the MCP client reports about itself.

With the `tools` surface the server exposes that profile's tools under
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
