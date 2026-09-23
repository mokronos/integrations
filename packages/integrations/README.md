# @integragents/host

One catalog of MCP endpoints and OpenAPI documents, the connections that
authorize them, and one way to call a tool. Wire contracts and the shared
vocabulary come from `@integragents/contracts`.

## Layout

| Directory | Holds |
| --- | --- |
| `storage/` | The two swappable seams: `Database` (rows) and `CredentialStore` (sealed secrets) |
| `catalog/` | What is installed — the row store, auth-method derivation, package-internal ids |
| `mcp/` | The MCP client, and reading its result envelope |
| `openapi/` | Compiling a document, building a request, invoking, Google Discovery, the spec cache |
| `oauth/` | Discovery, registration, PKCE, refresh |
| `integrations.ts` | The one service where both halves meet: `Integrations` |
| `runtime.ts` | Layer composition |

## What it is built on

| Library | Does |
| --- | --- |
| `@modelcontextprotocol/client` | MCP transports and framing, plus the OAuth 2.1 flow primitives — which serve OpenAPI connections too, so there is one OAuth implementation |
| `oas` | Projects an OpenAPI operation's parameters and responses into JSON Schema |
| `oas-normalize` | Parses, upconverts Swagger 2.0, and bundles a document |
| `@effect/sql-libsql` | The SQLite driver behind the local host's `SqlClient` |
| `drizzle-orm` | Declares the tables; `drizzle-kit` turns them into the embedded migrations |

Request building, the Google Discovery converter, persistence and credential
sealing are ours.

## Storage

Every table lives on whatever `SqlClient` the host provides: the local host's
SQLite file, a D1 binding, or the embedding application's own database. The
catalog tables are declared in `src/db/schema.ts` and applied through the
`integration_migration` ledger, or by the host's own migration pipeline when it
owns the schema. Credentials sit in the `credential` table sealed with the
host's master key, so a database dump is not a secret spill.
