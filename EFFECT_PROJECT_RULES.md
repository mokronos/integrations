# Additional Effect Project Rules

Only rules not already covered by `AGENTS.md` or the current `effect-solutions` guides.

- **Stay in Effect:** Keep workflows as `Effect<A, E, R>` until a real external boundary; do not add Promise facades or nested runtimes.
- **Own background work:** Fork into the owner's scope and acquire/release every listener, socket, handle, and port.
- **Never discard failures:** Propagate or record every Promise/fiber failure; ignore only explicitly irrelevant best-effort failures.
- **Search Effect first:** Check stable and unstable modules before building platform or stateful infrastructure yourself.
- **Verify semantics:** Check algorithms, failure caching, scope ownership, and stream/process lifetimes before replacing an implementation.
- **Evict transient failures:** Invalidate failed `Cache` entries when later requests should retry the lookup.
- **Use Effect time throughout:** Use `Clock`/`DateTime`, `Duration`, and `Schedule`; one nested `Date.now()` defeats `TestClock`.
- **Persist durable retries:** Store cross-restart attempt state and next-run time instead of treating an in-memory `Schedule` as durable state.
- **Spawn deliberately:** Use `ChildProcess` normally; use raw spawn only when a detached process must outlive its parent fiber.
- **Keep bytes portable:** Use `Uint8Array` and `Encoding`; confine `Buffer` to Node adapters and reject malformed encodings immediately.
- **Inject crypto:** Generate IDs, secrets, state, random bytes, and supported hashes through the `Crypto` service.
- **Derive API clients:** Generate TypeScript and dashboard clients from the shared `HttpApi` definition instead of restating transport contracts.
- **Keep API definitions light:** Shared definitions may depend on schemas and tags, never server layers, stores, platforms, or implementation barrels.
- **Skip empty generators:** Return or pipe one existing effect directly instead of wrapping it in a one-`yield*` `Effect.gen`.
- **Pin prereleases:** Use exact compatible versions for prerelease Effect packages, not floating release-candidate tags.
