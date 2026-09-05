# Using Integrations

This project separates the interfaces an agent uses from the interfaces a
human operator uses to run and administer the gateway.

## Guided setup

Open the dashboard on a new gateway to start onboarding. Connect a service,
select tools, and create a client with its own access profile and approval
policy. Reads can run directly; other selected tools require approval. You can
also require approval for every call. Client setup is atomic and grants no
administrative capabilities.

The next steps issue a key, provide MCP and CLI configuration, verify the key's
delegated access, and show the client's first calls. Copy the key before leaving:
it is kept only in memory and cannot be retrieved after a reload.

To replay onboarding, open **`/onboarding`** on the dashboard's origin. This route
is intentionally absent from navigation. It works after completion or skipping,
and lets you reuse an existing connection and client. Opening it creates nothing
and never resets accounts, policies, or keys. Issuing another key is an explicit
action; previous keys remain valid until revoked on the client page.

## Approval execution

Approval retries are scoped to the tenant, client, complete connection alias,
tool, assigned configurations, and exact arguments. Approval executes against
that frozen connection. Concurrent decisions compete for one durable database
claim before any provider call occurs.

An approval in `executing` cannot be approved, denied, expired, or collected.
If the gateway process stops after claiming it, the provider may already have
performed the action. The gateway preserves that state rather than retrying.
Check the provider before requesting the action again. This prevents automatic
duplicate execution; it does not promise exactly-once delivery across an
external provider and the gateway database.

## Agent access

An agent is a delegated caller. It receives an API key and can use only the
effective tools in the intersection of that key's client's assigned policy and
the connections that client has been granted.

### Command line

Install the CLI package with Bun:

```bash
bun add --global @mokronos/integrations-cli
```

Use `i` for an agent-facing command line interface:

```bash
i discover <url>
i connect <integration>
i tools <integration>
i schema <integration> <tool>
i execute <alias> <tool> <arguments>
```

`i` can search and discover integrations, create and remove its connections,
inspect tools and schemas, invoke effective policy tools, validate configuration, and
read its own approval records. It cannot issue API keys, change policies, or
approve calls.

### TypeScript client

Install the client in a Bun or TypeScript application:

```bash
bun add @mokronos/integrations-client
```

Create an authenticated client for a running gateway:

```ts
import { createGatewayClient } from "@mokronos/integrations-client"

const gateway = createGatewayClient({
  url: "http://127.0.0.1:4788",
  apiKey: "agent-api-key"
})

const outcome = await gateway.execute({
  alias: "org--github--work",
  tool: "create_issue",
  arguments: { title: "Example" }
})
```

The client exposes discovery, connection management, tool/schema lookup,
validation, invocation, and approval polling. The gateway retains credentials,
selects connections, applies policy, and may return a pending
approval outcome rather than execute immediately.

### HTTP API

Custom agents can call the versioned HTTP API directly with their API key. The
agent-facing endpoints include `/v1/integrations`, `/v1/connections`,
`/v1/tools`, `/v1/execute`, and `/v1/approvals/:id`.

## Operator access

A human operator uses `ii`, which includes all `i` commands and adds gateway
administration:

```bash
ii login
ii client <name>
ii key <client-id>
ii policies
ii policy <name>
ii policy-tool <policy-id> <integration> <tool> <allow|require-approval>
ii assign-policy <client-id> <policy-id>
ii approvals
ii approve <approval-id>
ii audit
```

Use `ii` to manage connections, clients, API keys, policies, approvals, audit
records, tool drift, account settings, and gateway lifecycle. Do not give this
operator surface to delegated agents.

The browser control plane is the visual operator interface. It manages the
catalog, connections, policies, approvals, audit trail, drift, and account
settings.

## Starting and hosting the gateway

### Local gateway

Start a foreground gateway for temporary use:

```bash
ii serve
```

Start it in the background:

```bash
ii serve --detach
```

Install it as a persistent per-user service for normal local use:

```bash
ii install
```

Remove the service with `ii uninstall`. The default local address is
`http://127.0.0.1:4788`. Gateway state, including sealed credentials and its
SQLite database, is stored in `~/.integrations`; set `INTEGRATIONS_HOME` to
choose a different state directory.

The local gateway serves its HTTP API under `/v1/*` and its browser control
plane at `/`. Open the control plane with:

```bash
ii dashboard
```

### Source checkout

For development from this repository:

```bash
bun install
bun run ii -- serve
```

After changing gateway sources, replace the running local gateway with one
loaded from the checkout:

```bash
bun run refresh
```

For control-plane development, use `bun run dev:control-plane`; to build the
assets and serve them from a source-pinned gateway, use
`bun run serve:control-plane -- --detach`.

### Cloudflare Worker

Use the Cloudflare host for a shared, hosted deployment. It runs the gateway in
a Worker, stores data in D1, serves the built control plane, and runs
maintenance on a five-minute cron.

```bash
bun run --cwd apps/host-cloudflare dev
bun run --cwd apps/host-cloudflare deploy
bun run --cwd apps/host-cloudflare deploy:staging
```

Set `INTEGRATIONS_MASTER_KEY` before deployment. Configure the public URL,
Google OAuth, signup policy, and observability through the Worker configuration
and secrets as needed.
