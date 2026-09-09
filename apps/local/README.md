# @mokronos/integrations

The integration gateway. Holds connections and credentials, intersects reusable
policies with client-specific connection grants, and performs invocations — so callers
hold only an API key and never a credential.

## Storage

`INTEGRATIONS_HOME`, falling back to `~/.integrations`. The directory
holds the integration catalog, sealed credentials, and the gateway's own store
(`gateway.sqlite`).

## The control plane

`serveGateway` also serves the browser control plane at the root of the same
port. `bun run build` builds the dashboard and places it in this package's
`web/` directory, so the published package contains the complete local product.

`bun run refresh` builds that same artifact before restarting the local gateway.

Pass `{ web: false }` to `serveGateway` for a headless gateway with nothing but
the API on the port.

Requests from that page carry no API key. `src/http/loopback.ts` decides when a
request may borrow the local client's credential instead, and documents both
what that defends against and what it does not.
