# integrations

`integrations` is an agent-facing gateway for discovering external APIs,
holding their credentials, granting clients access to individual tools, and
executing calls under policy.

The gateway is the only component that sees credentials. Clients receive an API
key and invoke logical `{ alias, tool }` addresses through the HTTP API.

## Surfaces

| Path | Purpose |
| --- | --- |
| `apps/integrations/gateway/` | Gateway domain, persistence, policy, HTTP API, and local service |
| `apps/integrations/cli/` | `integrations` and `i` command-line client |
| `apps/integrations/ts/` | `@mokronos/integrations-client`, the thin TypeScript gateway client |
| `apps/integrations/web/` | Browser control plane |
| `apps/integrations/worker/` | Cloudflare Worker runtime |
| `packages/integrations-executor/` | Internal Executor-backed integration host |
| `docs/` | Gateway decisions, deployment notes, and client references |

`CONTEXT.md` defines the gateway's domain language. `VISION.md` records product
direction.

## Development

```bash
bun install
bun run typecheck
bun test
bun run build
bun run build:control-plane
```

Run the CLI from source with:

```bash
bun run cli --help
bun run cli serve
```

State defaults to `~/.integrations`; set `INTEGRATIONS_HOME` to use another
directory.

## Clients

The TypeScript client communicates only with the versioned gateway HTTP API.
Applications such as [`wf`](https://github.com/mokronos/wf) consume the client
without importing gateway implementation or Executor packages.
