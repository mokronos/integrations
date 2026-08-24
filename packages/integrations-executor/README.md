# @mokronos/integrations-executor

The gateway's integration host: one catalog of MCP endpoints and OpenAPI
documents, the connections that authorize them, and one way to call a tool.

It owns local persistence, sealed credentials, endpoint detection, connections,
tool schemas, OAuth, and invocation. It has no dependency on a workflow runtime.

## What it is built on

The host is implemented directly against the protocols rather than through an
integration SDK — see `docs/adr/0009`. Three libraries do the parts that are
genuinely someone else's problem:

| Library | What it does here |
| --- | --- |
| `@modelcontextprotocol/sdk` | MCP transports and JSON-RPC framing, plus the OAuth 2.1 flow primitives — metadata discovery, dynamic client registration, PKCE, refresh — which serve OpenAPI connections too |
| `oas` | Projects an OpenAPI operation's parameters and responses into JSON Schema |
| `oas-normalize` | Parses, upconverts Swagger 2.0, and bundles a document |

Everything else is here: the request builder, the Google Discovery converter,
persistence, credential sealing, and the addressing and policy above them.

## Shape

Every capability is an Effect service with its own dependencies. Three seams are
meant to be replaced:

- `Database` — where rows live. A Cloudflare D1 binding satisfies it.
- `CredentialStore` — where secrets live.
- `clientsLayer` — what talks to the network. A test replaces this and keeps
  addressing, policy and credential resolution as the real thing.

`runtime.ts` composes them: `localLayer` for a directory on disk, `hostLayer`
for caller-supplied storage, `testLayer` and `stubbedLayer` for tests.

## Boundary

The package's own code is Effect throughout. `createExecutorServices` is the
Promise-facing adapter the gateway, CLI and dashboard consume, and the one place
the two styles meet; it also decodes caller-supplied strings into branded
identifiers. Wire contracts live in `@mokronos/integrations-protocol` and are
re-exported here.

## Storage

`integrations.sqlite` holds the catalog; `credentials.json` holds AES-256-GCM
sealed secrets under the owner-only key `credentials.key`. No database column
ever holds a credential, so a database dump is not a secret spill.

A Cloudflare deployment seals with the same envelope but a key derived from the
gateway's master key, so secrets do not move between deployments: a connection
made in one has to be made again in the other.
