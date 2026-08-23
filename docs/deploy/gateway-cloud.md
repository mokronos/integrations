# Hosting the gateway

The gateway runs unchanged as a local daemon or a hosted service; what differs
is where it binds, how it is reached, and which environment variables are set.
This guide covers taking an existing deployment public. The design decisions
behind it are in [ADR 0004](../adr/0004-the-gateway-is-one-product-with-two-deployments.md).

## Modes

- **Local (default).** `ii serve` binds `127.0.0.1`, bootstraps the
  local client, and lets the dashboard borrow its credential over loopback. No
  environment variables required.
- **Hosted.** The gateway binds off loopback behind a TLS proxy, humans sign in
  at `/` with a password or Google, and clients authenticate with issued API
  keys from anywhere.

## Environment variables

| Variable | Meaning | Default |
| --- | --- | --- |
| `INTEGRATIONS_PUBLIC_URL` | Origin callers reach, e.g. `https://gw.example.com`. Enables hosted OAuth callbacks at `/v1/oauth/callback`. | unset — OAuth uses loopback listeners |
| `INTEGRATIONS_GOOGLE_CLIENT_ID` | OAuth client id for human dashboard/`ii` sign-in. Configure its redirect as `<PUBLIC_URL>/v1/auth/google/callback`. | unset — Google sign-in hidden |
| `INTEGRATIONS_GOOGLE_CLIENT_SECRET` | Secret paired with the human sign-in OAuth client. Keep it in the deployment secret store. | unset |
| `INTEGRATIONS_ALLOW_SIGNUP` | `1` opens signup after the first human has claimed the instance. The first signup is always allowed while no login exists. | closed |
| `INTEGRATIONS_MASTER_KEY` | Base64url of 32 bytes; seals approval/audit payloads at rest. Omitted, a `gateway.key` file is minted inside the home directory on first start. | unset |
| `INTEGRATIONS_RATE_LIMIT` | Per-principal requests per minute; per-address limit is a fifth of this, floored at 20. | `600` |
| `INTEGRATIONS_MAX_BODY_BYTES` | Largest accepted JSON body. | `1048576` (1 MiB) |
| `INTEGRATIONS_HOME` | Data directory. | `~/.integrations` |

Session cookies gain their `Secure` flag automatically when the socket is bound
off loopback — no variable for that, because it follows from how you serve.

## TLS

The gateway speaks plain HTTP; terminate TLS in front of it. Caddy is enough:

```
gw.example.com {
    reverse_proxy 127.0.0.1:4788
}
```

Then run the gateway on loopback of the same box (`ii serve --host
127.0.0.1`) or bind it privately if proxy and gateway differ. Binding directly
off loopback without TLS in front publishes every credential it holds.

## Deployment targets

Any long-running host works; the gateway is one Bun process plus a data
directory.

**Fly.io** — create an app with a volume mounted at `/data`, set
`INTEGRATIONS_HOME=/data`, put Caddy or Fly's proxy in front:

```bash
fly launch --image bun
fly volumes create wf_data --size 3
fly secrets set INTEGRATIONS_MASTER_KEY="$(openssl rand -base64 32 | tr '/+' '_-' | tr -d '=')"
fly secrets set INTEGRATIONS_PUBLIC_URL="https://<app>.fly.dev"
fly deploy
```

Compute for the smallest always-on machine is about USD 2/month; volumes bill
by provisioned size.

**A small VPS** (Hetzner, Oracle Cloud's always-free ARM) — install Bun,
clone and build, then run under systemd with `INTEGRATIONS_HOME` pointed at a
persistent directory and Caddy on ports 80/443. The CLI can also register a
user service (`ii install`), but on a server a system unit
with `Restart=always` is the better shape.

## First run

1. Start the gateway once. A `gateway.key` appears in the home directory unless
   `INTEGRATIONS_MASTER_KEY` was set.
2. Visit the site and sign up — the first signup claims the instance and mints
   its tenant.
3. Register your OAuth redirect with vendors whose apps require fixed URIs:
   `<PUBLIC_URL>/v1/oauth/callback`. Dynamic-client-registration providers need
   nothing.
4. To enable human Google sign-in, create a Web OAuth client with the redirect
   `<PUBLIC_URL>/v1/auth/google/callback`, then set both Google variables above.
5. Create clients and keys from the dashboard, then point each agent at the
   gateway: `INTEGRATIONS_URL=https://… INTEGRATIONS_API_KEY=wfi_…`.

## Operational notes

- **Back up `gateway.key` together with `gateway.sqlite`.** Sealed payloads are
  authenticated with that key; a database restored without it loses those
  columns' contents (records survive, arguments and results do not).
- **Vendor credentials live in Executor's own storage** inside the same home
  directory. This gateway seals its own payloads but not those files; give the
  volume full-disk encryption (LUKS, or an encrypted block device) so a leaked
  disk image alone yields no tokens.
- **Rate limits live in process.** For anything seriously hostile, use the
  platform edge (Fly's proxy rules, Cloudflare in front) rather than raising
  the in-process budget.
- **Maintenance runs itself**: approvals expire, audit arguments age out,
  sessions expire — all on the internal minute loop. No cron needed while the
  process runs.

## Cloudflare staging

The Worker deployment uses D1, Workers Static Assets, and a Cron Trigger. Its
isolated staging environment is configured in
`apps/integrations/worker/wrangler.jsonc`:

```bash
cd apps/integrations/worker
bun run deploy:staging
INTEGRATIONS_STAGING_URL=https://integrations-gateway-staging.games-97f.workers.dev \
  bun run --cwd ../cli test:hosted
```

The hosted acceptance signs up an ephemeral tenant over real TLS, verifies
session and delegated-key boundaries, starts OAuth dynamic registration against
Linear's real remote MCP provider, and then removes the tenant. It deliberately
does not authorize a Linear account; completing that consent screen is a human
acceptance step.
