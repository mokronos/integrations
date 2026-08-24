# The integration host is ours

The gateway previously reached MCP endpoints and OpenAPI documents through
`@executor-js/sdk` and its MCP and OpenAPI plugins. It now implements that host
itself, against the protocols directly.

## Why

The SDK's surface was far wider than the gateway's use of it. Of what it offers
— artifacts, tool policies, an admin/platform view, health checks, elicitation,
a blob store, pending approvals, migration specs, React panels — the gateway used
none: it owns policy, approvals and audit in its own store, above the host, for
the reasons recorded in ADR 0001. What it did use was a small subset: catalog
reads, connection CRUD, five OAuth calls, tool listing and schema, and execute.

That subset carried the whole dependency graph, including `fumadb`, `kysely`,
`drizzle-orm`, two majors of `zod`, `@clack/prompts` and `lucide-react` — a React
icon set in a headless gateway's tree.

## What replaces it

The protocols, plus libraries for the parts that are genuinely someone else's
problem:

- `@modelcontextprotocol/sdk` for MCP transports and framing, and for the OAuth
  2.1 flow primitives. Those are standalone functions, not bound to MCP, so they
  serve OpenAPI connections too and no second OAuth implementation is needed.
- `oas` to project an operation's parameters and responses into JSON Schema.
- `oas-normalize` to parse, upconvert Swagger 2.0, and bundle.

Two things were considered as libraries and implemented here instead, each for a
measured reason:

- **Google Discovery conversion.** `google-discovery-to-swagger` was last
  released in 2019 and loses information on current documents: run Gmail through
  it and `users.messages.send` comes back with a `message/cpim` content type and
  no usable request-body schema — a tool that looks callable and is not.
- **Request building.** `swagger-client.buildRequest` is correct and
  battle-tested, but reaching it pulls the 39-package `@swagger-api/apidom-*`
  tree, worth about 2.5 MB in a bundle that ships to Cloudflare Workers, for
  features we do not use. What we used is OpenAPI's `style`/`explode` table,
  which is a closed set of rules over data the compiled operation already holds.

## Consequences

- Bundling the host is 3.4 MB rather than 5.9 MB, and the workspace installs 583
  packages rather than 599.
- Documents are **bundled, not dereferenced**. Dereferencing a recursive schema —
  Gmail's `Message` contains `MessagePart`, which contains itself — produces a
  cyclic object graph, and `oas` clones schemas through `JSON.stringify`, so it
  throws on one. Internal `$ref`s therefore survive compilation, and a published
  tool schema carries the definitions it reaches under `$defs`.
- A newly created grant defaults to `allow` only for a tool whose own source
  declares it read-only. For MCP that is `readOnlyHint`, read straight off
  `tools/list`; for OpenAPI it is a safe HTTP method, which is a stronger claim
  than any annotation because the protocol defines it rather than the vendor
  asserting it. This replaces reverse-engineering an undeclared annotation stamp.
- Wire contracts are unchanged, so the published TypeScript client, the CLI and
  the dashboard were unaffected. ADR 0006 is what made that true.
- Storage is the host's own: `integrations.sqlite` and `credentials.json`, with
  no ORM runtime-schema layer. The Cloudflare port is two layers — a `Database`
  and a `CredentialStore` over one D1 binding.

## Status

The package keeps the name `@mokronos/integrations-executor` and its
`Executor*`-prefixed exported types. Those are the wire vocabulary that
`@mokronos/integrations-client` and its consumers compile against; renaming them
would be a breaking change to published packages for no functional gain, and is
best done, if ever, as its own deliberate release.
