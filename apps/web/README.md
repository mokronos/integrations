# The gateway's control plane

The human control plane for the integration gateway: readiness overview,
catalog and connections, per-tool grants, clients and keys, approvals, account
settings, drift checks, and the permanent activity trail. Headless validation,
direct invocation, and maintenance stay in the API and `ii` CLI instead of
competing with those workflows in the dashboard.

## Running it

In normal use the installed gateway serves this at the root of its own port:

```bash
ii serve -d
ii dashboard      # opens http://127.0.0.1:4788
```

A `vite build` is enough to refresh it in a working tree — the gateway resolves
`apps/integrations/web/dist` from disk, so there is no binary to recompile.
For a source checkout, start a gateway pinned to the working tree once:

```bash
bun run serve:control-plane -- --detach
```

Then refresh and open it with:

```bash
bun run refresh:control-plane
```

For iteration:

```bash
bun run --cwd apps/integrations/web dev
```

The dev server proxies `/v1` to the gateway and rewrites the `Origin` header to
the gateway's own. That rewrite is why development works at all: the page is on
5173 and the gateway is on 4788, so without it every call is a cross-origin
request and the gateway refuses to treat it as its own page. Point it elsewhere
with `INTEGRATIONS_URL`.

## How it talks to the gateway

`src/lib/gateway.ts` is the browser's API surface, and it has no API key in it.
A hosted browser carries its HTTP-only human session; a same-origin loopback
browser may borrow the local operator context. See
`apps/integrations/gateway/src/http/loopback.ts` for where the local path holds
and where it stops holding.

`src/lib/schemas.ts` decodes every response. It does not restate the gateway's
types — it imports the gateway's own `domain.ts` and derives each JSON codec
with `Schema.toCodecJson`, so a field that changes shape there fails to decode
here rather than rendering as `undefined` three screens away.

## Components

shadcn, `radix-nova` style, added through the CLI:

```bash
bunx --bun shadcn@latest add <component>
```

`src/components/ui` is vendored and regenerable, so prefer adding a component
over hand-rolling one. `sonner.tsx` deliberately has no `next-themes`
dependency; the application supplies the active theme directly.
