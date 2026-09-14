# General Engineering Lessons from the Last 40 Commits

This is the non-Effect companion to `EFFECT_LESSONS.md`, covering `6f4ba71` through `55341de`.

Ratings use the same five-point scale as the Effect review: **5** is correctness or architecture critical, **4** is high impact, **3** matters in the relevant subsystem, **2** is useful cleanup, and **1** is situational.

- **5/5 — Authorize against resource ownership, not the caller's credential shape** (`6f4ba71`). Connections belong to tenants, so an already-authorized human session must not be rejected merely because it is not a client API key.
- **5/5 — Make destructive operations describe and enforce their whole cascade** (`a44a65c`). Integration removal must clean up connections, credentials, and policy references, validate ownership, and tell the operator what disappears.
- **4/5 — Separate stable identity from presentation** (`ab3b990`). Let display names change without changing stable slugs or addresses; expose the actual generated alias callers must use.
- **5/5 — Prove external identifiers are injective** (`04445ba`). Reserve separators, escape every field reversibly, include all identity components, and test collisions—not only happy examples.
- **4/5 — Split deterministic compatibility tests from live probes** (`d7e2e96`, `02ffbb3`). Pin representative fixtures for reproducible CI and run remote checks separately to detect real provider/protocol drift.
- **5/5 — Persist workflows that must survive process boundaries** (`adbd90d`, `ad8a3eb`). Store delivery jobs and approval state, claim transitions atomically, make retries idempotent, sign outbound webhooks, and expose delivery status.
- **3/5 — Expose actionable operation state** (`7925814`, `9ab9c2f`). Distinguish expired credentials, reauthorization needs, progress, verification, and terminal failures instead of presenting a generic broken/not-broken flag.
- **5/5 — Test through the behavior that can actually fail** (`23c8a52`, `1a4c3b3`, `e6ba571`). A fake alias can make an authorization test pass before it reaches the intended rule. Remove tests that restate declarations and retain tests that exercise the invariant through its real path.
- **5/5 — Keep one source of truth for contracts** (`277abbf`, `4158a0a`, `ec4197e`, `55341de`). Derive clients and response types from the API; derive complete policy decisions from the catalog rather than maintaining partial parallel models.
- **4/5 — Protect dependency boundaries and bundle size** (`6fb8cde`). Separate definitions/tags from implementations, expose narrow package entry points, and verify browser consumers do not import server graphs.
- **3/5 — Use names that identify responsibility** (`015fc1a`, `2aa4029`). Package, service, variable, and test names should distinguish domain capabilities, clients, deployment hosts, and remote addresses.
- **2/5 — Delete stale explanation and obsolete compatibility layers** (`367370f`, `e5cf467`, `3467f28`, `409f856`). Keep rationale that preserves a non-obvious invariant; remove comments, wrappers, and docs that merely narrate old structure.
- **3/5 — Model only what an endpoint consumes** (`bdaa004`). Do not declare wildcard parameters or response fields just because the router can produce them.
- **4/5 — Treat dependency versions as build inputs** (`1a4c3b3`). Pin prereleases; a floating release-candidate tag can change APIs without any repository change.
