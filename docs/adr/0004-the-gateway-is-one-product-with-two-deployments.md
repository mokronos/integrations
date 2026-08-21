# The gateway is one product with two deployments

The integration gateway ran as a local daemon: bound to loopback, one implicit
tenant per deployment, the browser trusted by network locality. Hosting it —
one service, many tenants, humans signing in to a dashboard — changes the trust
model, and this record captures the decisions that change entailed. The local
mode is unchanged and remains the default; every decision below is a
conditional on being served off-loopback or on request.

## Decisions

- **Tenancy is a column, not an instance.** Every gateway-owned row carries
  `tenant_id` and every read is scoped by it. A pre-existing deployment is
  migrated in place into a well-known default tenant rather than declared
  legacy; signup mints a fresh partition per account, and joining an existing
  tenant stays an operator action.
- **Humans authenticate as themselves, not through clients.** A login (email +
  scrypt-hashed password) attaches to a subject; a session is a bearer token
  stored only as its SHA-256. Sessions may reach privileged surfaces but never
  the delegated invoke surface — delegating to a machine means issuing it a
  client key, which keeps ADRs 0001–0002 intact.
- **Cookie-carried authority must prove same-origin on writes** (`Sec-Fetch-Site`
  / `Origin`), because the browser spends a session without ever seeing the
  token. Key-in-header requests need no such check.
- **Hosted OAuth callbacks live at the gateway's public URL.** `INTEGRATIONS_
  PUBLIC_URL` switches flows from ephemeral loopback listeners to
  `/v1/oauth/callback`, where the provider's echoed state selects the pending
  flow; states are consumed once, so replays are inert.
- **Payloads are sealed at rest when a master key exists**, from the
  environment or a minted keyfile: frozen-call arguments, settled results, and
  audit arguments — the columns where caller PII lives. Retry matching rides a
  keyed HMAC because randomised sealing forbids equality search. Unconfigured
  gateways stay plaintext; enabling a key is not a migration. Vendor
  credentials remain in Executor's own storage and are covered operationally
  (encrypted volume), not here.
- **Rate limits are in-process and modest**: per-address before authentication,
  per-principal after. They turn accidents into 429s; the edge in front of a
  hosted gateway owns anything larger.

## Considered options

- **One deployment per tenant** (containers per customer) — rejected: the
  operational surface grows linearly for a property most tenants never query.
- **Passwordless only** (magic links, WebAuthn) — deferred: both need external
  services or platform commitments; scrypt passwords keep the hosted path
  self-contained. Sessions are shaped so a second factor can slot in front of
  session creation later.
- **Encrypting everything including vendor credentials now** — rejected until
  Executor's storage is addressable from here; sealing half the secret set and
  claiming the rest would be worse than stating the boundary.

## Consequences

- The first human to sign up claims an instance whose logins table is empty;
  operators who want open registration set `INTEGRATIONS_ALLOW_SIGNUP=1`.
- Local development is untouched: loopback borrow still works, no env vars are
  required, and existing databases migrate transparently.
- A runtime port (e.g. Cloudflare Workers) can come later without revisiting
  these decisions: the HTTP layer is already Request→Response, storage speaks
  SQL over libsql, and the two clock-driven duties (maintenance sweeps,
  session expiry) are already separated from request handling.
