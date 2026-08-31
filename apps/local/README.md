# @mokronos/integrations-local

The integration gateway. Holds connections and credentials, intersects reusable
policies with client-specific bindings, and performs invocations — so callers
hold only an API key and never a credential.

Vocabulary is defined in [CONTEXT.md](../../../CONTEXT.md). The reusable policy
boundary is recorded in
[ADR 0001](../../../docs/adr/0001-reusable-policies-bind-to-distinct-clients.md).

## Storage

`INTEGRATIONS_HOME`, falling back to `~/.integrations`. The directory
holds the integration catalog, sealed credentials, and the gateway's own store
(`gateway.sqlite`).

## The control plane

`serveGateway` also serves the browser control plane built from
`apps/integrations/web`, at the root of the same port. Assets are resolved from
disk in this order:

1. `INTEGRATIONS_WEB_DIR`
2. `<this package>/web` — the published layout, written by `bun run build:web`
3. `../web/dist` — the source checkout, so `vite build` is enough in a working
   tree

Pass `{ web: false }` to `serveGateway` for a headless gateway with nothing but
the API on the port.

Requests from that page carry no API key. `src/http/loopback.ts` decides when a
request may borrow the local client's credential instead, and documents both
what that defends against and what it does not.
