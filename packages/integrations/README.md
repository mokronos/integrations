# @mokronos/integrations

One catalog of MCP endpoints and OpenAPI documents, the connections that
authorize them, and one way to call a tool. Wire contracts and the shared
vocabulary come from `@mokronos/contracts`.

## Layout

| Directory | Holds |
| --- | --- |
| `storage/` | The two swappable seams: `Database` (rows) and `CredentialStore` (sealed secrets) |
| `catalog/` | What is installed — the row store, auth-method derivation, host-internal ids |
| `mcp/` | The MCP client, and reading its result envelope |
| `openapi/` | Compiling a document, building a request, invoking, Google Discovery, the spec cache |
| `oauth/` | Discovery, registration, PKCE, refresh |
| `facade/` | The Promise surface the gateway consumes. Transitional — see below |
| `host.ts` | The one service where both halves meet |
| `runtime.ts` | Layer composition |

## What it is built on

| Library | Does |
| --- | --- |
| `@modelcontextprotocol/sdk` | MCP transports and framing, plus the OAuth 2.1 flow primitives — which serve OpenAPI connections too, so there is one OAuth implementation |
| `oas` | Projects an OpenAPI operation's parameters and responses into JSON Schema |
| `oas-normalize` | Parses, upconverts Swagger 2.0, and bundles a document |
| `@libsql/client` | The SQLite driver behind `Database` |

Request building, the Google Discovery converter, persistence and credential
sealing are ours.

## The facade

`facade/` exists because the gateway, CLI and dashboard are async/await while
this package is Effect throughout. It is the one place the two styles meet, and
it should be deleted when they converge — nothing in it adds behaviour.

## Storage

`integrations.sqlite` holds the catalog; `credentials.json` holds AES-256-GCM
sealed secrets under the owner-only key `credentials.key`. No database column
ever holds a credential, so a database dump is not a secret spill.

A Cloudflare deployment supplies its own `Database` and `CredentialStore` over
one D1 binding and reuses everything above them. It seals with the same envelope
but a key derived from the gateway's master key, so secrets do not move between
deployments.
