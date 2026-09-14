# Effect Lessons from the Last 40 Commits

This review covers the 40 commits from `6f4ba71` through `55341de`, in chronological order. It focuses on places where code was only wrapped in Effect, bypassed Effect, or rebuilt a capability Effect already provides. The conclusions were checked against `effect-solutions` and the Effect source installed for this repository.

Detailed lessons use a five-point importance scale: **5** is correctness or architecture critical, **4** is high-impact default practice, **3** is important in the relevant subsystem, **2** is useful cleanup, and **1** is situational.

## Commit-by-commit review

| Commit | Effect-specific finding |
| --- | --- |
| `6f4ba71` | Provisioning still crossed the integration Promise facade with `Effect.promise`; the tenant-scoping correction itself is a general domain lesson. |
| `a44a65c` | Integration discovery and removal still used the Promise facade and direct async boundaries later removed by `2c41893`, `c9f6385`, and `367370f`. |
| `ab3b990` | More behavior was added through the same Promise facade; the slug and naming work is primarily a general modeling lesson. |
| `04445ba` | No material Effect correction. The important lesson is collision-free external identifier encoding. |
| `d7e2e96` | Effect-based conformance tests were still hosted by Bun's test runner; `1a4c3b3` later moved the suite to `@effect/vitest`. |
| `adbd90d` | Durable webhook delivery caught and ignored failures and calculated retries manually. `23c8a52` made lost failures observable; `faa6c19` moved time units and jitter to Effect services. |
| `7925814` | OAuth health was modeled, but orchestration still crossed Promise boundaries that erased typed failures. |
| `9ab9c2f` | No material Effect correction; this was primarily user-facing operation-state feedback. |
| `ad8a3eb` | Added a large hand-written Promise HTTP client and duplicated API schemas. `277abbf` and `4158a0a` later derived clients from the API definition. |
| `2c41893` | Began replacing Promise integration access with typed services, branded identifiers, boundary decoding, and captured defects with correlation IDs. |
| `23c8a52` | Replaced detached promises with scoped fibers, `Deferred`, and acquire/release; split opaque errors into schemas; stopped silently discarding failures; reused one managed runtime. |
| `c9f6385` | Moved discovery, provisioning, and validation from Promise wrappers to effects over the integrations service context. |
| `367370f` | Deleted the Promise facade and its second runtime; retained `Effect.runPromise` only at composition boundaries. |
| `e5cf467` | No Effect correction. Removed stale documentation and dead references. |
| `02ffbb3` | No general Effect correction; migrated the MCP implementation and conformance fixtures to the 2026 protocol. |
| `98e5044` | Recorded that unstable Effect modules are acceptable here. This permits using maintained Effect capabilities instead of local substitutes, but does not remove the need to inspect their semantics. |
| `3467f28` | No Effect correction. Removed commentary that restated code or had become stale. |
| `6210a59` | Replaced native `fetch`, Promise-returning clients, Bun sleeps, and Promise CLI tasks with `HttpClient` and effects whose errors and requirements remain typed. |
| `af26370` | Deleted a hand-written fixed-window limiter in favor of Effect's `RateLimiter` and its memory store layer. |
| `b4cee00` | Deleted custom static-file routing, MIME detection, and traversal handling in favor of `HttpStaticServer`. |
| `faa6c19` | Replaced interval and polling loops with `Schedule`, bare millisecond values with `Duration`, and retry jitter with `Random`. |
| `d3d18fb` | Replaced an unbounded, race-prone `Map` cache with `Cache`, including explicit invalidation of cached failures. |
| `9f927fb` | Replaced scattered `process.env` reads and ad-hoc parsing with `Config`, schemas, and test `ConfigProvider`s. |
| `25c96b9` | Replaced `Buffer` conversion helpers with `Encoding`, `Result`, and portable `Uint8Array` values. |
| `8464208` | Replaced ambient random UUID/byte/hash calls with the `Crypto` service supplied by a cross-runtime Web Crypto layer. |
| `699e18b` | Replaced direct wall-clock reads and millisecond arithmetic with `DateTime`, `Duration`, and scheduled polling. |
| `e271167` | Replaced repeated `Bun.spawn` wrappers with `ChildProcess`; preserved raw spawn only for the genuinely detached process whose file descriptors must outlive the fiber. |
| `277abbf` | Replaced a hand-written TypeScript client, duplicate schemas, and duplicate error types with `HttpApiClient` derived from the API definition. |
| `6fb8cde` | Separated the API description and middleware tag from their implementations so client imports do not pull the server dependency graph into browser bundles. |
| `4158a0a` | Replaced the dashboard's third copy of routes and decoders with the same generated `HttpApiClient`. |
| `bbfb6bf` | Replaced a Promise libsql driver plus an 88-method Effect adapter with a direct `SqlClient` store and Effect-managed transactions and scope. |
| `ec4197e` | Made authorization refusals and shared gateway data Schema values, derived their TypeScript types, and centralized wire contracts. |
| `015fc1a` | Corrected package names and Effect service identifiers so tags describe and uniquely identify their actual owners. |
| `2aa4029` | Renamed services after what they do (`Integrations`, `McpClient`) and removed one-field service wrappers. |
| `409f856` | Removed `Effect.gen` blocks that did nothing except `yield*` one existing effect. |
| `bdaa004` | Removed unused wildcard parameter schemas from fallback endpoints; the API description now models only values handlers consume. |
| `e6ba571` | Removed tests that restated declarations or duplicated stronger behavior tests. |
| `1a4c3b3` | Adopted `@effect/vitest`, `it.effect`, scoped fixtures, and pinned Effect versions; uncovered Promise APIs and a never-awaited assertion hidden by a permissive runner helper. |
| `e965e88` | Removed the store's last direct `Date.now()`/`new Date()` reads so `TestClock` can govern expiry tests. |
| `55341de` | No new Effect primitive; it reinforces deriving policy state from the complete catalog rather than allowing partial policy states. |

## Detailed lessons

### 1. Keep an Effect workflow in Effect from end to end — 5/5

**What went wrong:** Integration operations and CLI tasks returned Promises, then callers repeatedly lifted them with `Effect.promise` or `Effect.tryPromise`. A compatibility facade owned its own `ManagedRuntime`, while the gateway created another runtime and extracted services only to inject them again. Typed failures became generic rejected promises and requirements disappeared from signatures.

**What fixed it:** `2c41893`, `c9f6385`, `367370f`, and `6210a59` made integration operations, HTTP clients, CLI tasks, and service operations return `Effect` directly. The service context is passed where multiple capabilities are needed. There is one runtime for each application concern, and `Effect.runPromise` appears at the actual async composition boundary.

**Do this initially:** If callers already run Effect, expose `Effect<A, E, R>` rather than Promise methods plus adapters. Preserve `E` and `R` through helper types. Construct and provide layers at the application edge; do not create nested runtimes to make Effect look like Promise code.

### 2. Supervise concurrency and scope resources — 5/5

**What went wrong:** The local OAuth flow used a detached `void promise.then(...)`. Shutdown could not cancel it, callback listener ownership was unclear, and failures in either promise arm vanished. MCP requests also created fresh runtimes rather than sharing the handler's lifetime.

**What fixed it:** `23c8a52` made the listener an `Effect.acquireRelease` resource, communicated callback arrival through `Deferred`, forked the flow into a parent scope, and closed that scope when the session manager stopped. Port release and fiber cancellation now follow the owning lifetime.

**Do this initially:** Model listeners, handles, files, sockets, and other acquired resources with acquire/release in a scope. Use fibers for concurrent effects and `Deferred` for one-shot coordination. Never detach a Promise or fiber unless its lifetime and failure destination are explicit.

### 3. Keep expected failures typed; capture genuinely unexpected failures — 5/5

**What went wrong:** OAuth stages collapsed into one error with an opaque cause, malformed database rows looked like database execution failures, and several best-effort operations used `ignore`, `orElseSucceed`, or `orDie`. Operators received unexplained 500s or no signal at all.

**What fixed it:** `2c41893` and `23c8a52` introduced stage-specific Schema errors, `MalformedRowError`, structured store failure kinds, and an error-capture service that attaches correlation IDs. HTTP handlers translate declared domain failures into declared API failures. `ec4197e` made authorization refusals wire-safe Schema values with stable codes and messages.

**Do this initially:** Use `Schema.TaggedError` variants for failures callers can understand or recover from. Decode external values at their boundary. Translate errors once at the transport edge. Use defects only for broken invariants or failures the current API deliberately cannot recover from, and ensure defects are recorded. `Effect.ignore` is appropriate only when failure is truly irrelevant to the contract, such as a best-effort browser launch—not as a substitute for observability.

### 4. Use Effect's HTTP stack rather than wrapping `fetch` — 4/5

**What went wrong:** Native `fetch` and custom transport services were wrapped with `tryPromise`; status checking, body reading, error conversion, dependencies, and tests were repeated throughout the CLI, gateway, MCP, OpenAPI, registry, and SDK code.

**What fixed it:** `6210a59` moved requests to `HttpClient`, `HttpClientRequest`, `HttpClientResponse`, and provided client layers. Network and body failures stay in the error channel, the client dependency stays in `R`, and tests can supply a client layer without replacing globals.

**Do this initially:** Make HTTP an explicit service dependency. Build requests and decode responses with the Effect HTTP APIs, map transport failures to domain failures at the owning boundary, and provide the platform client once in the application layer.

### 5. Prefer maintained Effect capabilities over local infrastructure — 4/5

Several commits deleted custom implementations:

- `af26370`: use `RateLimiter` and a store layer instead of a mutable `Map`, manual pruning, and retry-after arithmetic. Check the algorithm's semantics: Effect's limiter changed the old fixed-window burst behavior.
- `b4cee00`: use `HttpStaticServer` instead of maintaining MIME types, traversal containment, SPA fallback, ETags, conditional requests, and ranges by hand.
- `d3d18fb`: use `Cache` instead of an unbounded `Map` with duplicated miss logic. `Cache` shares in-flight lookup, bounds storage, and caches the lookup exit; invalidate on failure when transient failures must be retried.
- `e271167`: use `ChildProcess` for normal subprocesses so spawn errors, exit codes, output, interruption, and requirements are modeled consistently.
- `bbfb6bf`: use `SqlClient` and `withTransaction` instead of a raw client plus a method-for-method Effect adapter and manual `BEGIN`/`COMMIT`/`ROLLBACK` blocks.

**Do this initially:** Before adding a stateful helper or platform wrapper, search Effect—including unstable modules—and its platform packages. Confirm lifecycle, failure caching, algorithm, streaming, and portability semantics rather than assuming an abstraction is a drop-in replacement.

### 6. Use `Schedule`, `Duration`, `DateTime`, and `Clock` for time — 5/5

**What went wrong:** Polling loops counted iterations, maintenance used `setInterval`, sleeps used bare numbers, expiry arithmetic multiplied milliseconds, and production code mixed Effect's clock with `Date.now()`. Tests therefore had to use live time and could not advance expiry deterministically.

**What fixed it:** `faa6c19` and `699e18b` expressed repetition with `Schedule`, units with `Duration`, instants and arithmetic with `DateTime`, and jitter with `Random`. `e965e88` moved remaining store and maintenance reads onto Effect's `Clock`, allowing `it.effect` and `TestClock` to control them.

**Do this initially:** Never encode a duration as an unexplained number. Read time from Effect services throughout the complete call path; one direct `Date.now()` below an Effect API defeats `TestClock`. Use `Schedule` for in-process repetition and retry. Do not force it onto persisted retry state: the webhook attempt counter lives in the database across processes, so explicit persisted backoff arithmetic is the correct model there.

### 7. Read configuration through `Config` — 4/5

**What went wrong:** Eleven `process.env` reads had inconsistent trimming, blank handling, booleans, defaults, and invalid-value behavior. Tests mutated global environment state. A malformed rate limit silently became a default, and half of an OAuth credential pair was checked imperatively after reading.

**What fixed it:** `9f927fb` collected settings as `Config` values, parsed constrained numbers through Schema, validated dependent Google credentials together, shared one blank-is-unset helper, and tested against a fixed `ConfigProvider`.

**Do this initially:** Declare configuration once, including defaults and validation. Treat present-but-invalid values as startup failures. Validate related fields as one schema when combinations matter. In tests, provide configuration data rather than mutating process globals.

### 8. Treat bytes as portable data and conversions as fallible — 3/5

**What went wrong:** `Buffer` became both the byte representation and the conversion API throughout crypto code. Its base64 decoding accepted malformed input and failed later with misleading authentication errors. It also leaked a Node-specific type into Cloudflare code.

**What fixed it:** `25c96b9` used `Uint8Array` as the byte type, Effect's `Encoding` for UTF-8/base64/base64url, and named `Result`-based field decoders. Invalid envelope fields now fail where they are decoded. `Buffer` remains only where a Node API actually returns it.

**Do this initially:** Use `Uint8Array` across runtime-neutral boundaries. Decode text into bytes explicitly and handle the decoder's failure immediately. Confine platform-specific byte types to their platform adapter.

### 9. Inject randomness and hashing through `Crypto` — 4/5

**What went wrong:** Domain operations synchronously reached into `node:crypto` for IDs, state, secrets, and hashes. The dependency was invisible, hard to control, and unsuitable for all deployment targets.

**What fixed it:** `8464208` made minting operations effects over `Crypto.Crypto` and supplied a Web Crypto layer shared by Bun, Node, and Cloudflare. The requirement propagates through authentication, authorization, invocation, and tests. Node crypto remains only for primitives the Effect service does not expose.

**Do this initially:** Make entropy and supported hashing explicit service requirements. Provide one cross-runtime layer at the edge. Do not hide effectful ID generation inside otherwise pure object construction.

### 10. Derive clients and wire types from the API definition — 5/5

**What went wrong:** The server API, published TypeScript client, and dashboard independently declared routes, query encoding, response schemas, and errors. These copies could drift and added hundreds of lines of request plumbing.

**What fixed it:** `277abbf` and `4158a0a` derive both clients with `HttpApiClient`. `ec4197e` centralizes shared Schema contracts and derives TypeScript types from them.

**Do this initially:** Define each endpoint and payload schema once. Generate or derive clients from that definition. Keep small adapters only for intentional public ergonomics, credentials, or application-specific error presentation—not to restate transport contracts.

### 11. Keep API descriptions free of implementation dependencies — 4/5

**What went wrong:** Once clients imported the API definition, the definition's import of the implemented `Authority` middleware dragged the store, libsql, and MCP SDK into browser bundles.

**What fixed it:** `6fb8cde` split the middleware tag from its layer implementation and added a definition-only package export. The API definition imports narrow schema modules instead of implementation barrels.

**Do this initially:** A shared API description may depend on schemas and service tags, but not server implementations. Put layers in server-only modules, provide narrow export paths, and avoid barrels that make type/definition imports pull runtime graphs.

### 12. Use Schema as the source of truth for domain and wire models — 5/5

**What went wrong:** Plain strings represented integration slugs, connection names, and tool names; refusal outcomes and messages were assembled separately; external caller input was sometimes asserted instead of decoded.

**What fixed it:** `2c41893` branded identifiers and decoded input. `23c8a52` added structured failure variants. `ec4197e` published authorization refusals and gateway contracts as schemas and derived their TypeScript types.

**Do this initially:** Brand identifiers that are easy to mix up. Model state machines and failures as discriminated Schema unions. Derive types via `typeof Schema.Type`, and decode untrusted data rather than casting it.

### 13. Test Effect code with Effect's test integration — 5/5

**What went wrong:** A permissive helper accepted an Effect, a Promise-like value, or a plain value, hiding which execution model a test used. One rejected-Promise assertion was never awaited. Module-level cleanup arrays and `afterEach` hooks managed resources manually. Floating release-candidate dependencies made installs non-reproducible.

**What fixed it:** `1a4c3b3` adopted `@effect/vitest`, `it.effect`, and scoped fixtures while retaining Bun as the runtime. `e965e88` removed direct system-clock reads so most `it.live` tests became deterministic Effect tests. Effect packages were pinned to a known compatible version.

**Do this initially:** Use `it.effect` for Effect programs and scoped acquisition for fixtures. Use `it.live` only when the subject intentionally depends on OS time or real external resources. Avoid runners that blur Effect and Promise types. Pin prerelease dependency versions.

### 14. Do not add Effect ceremony around an existing Effect — 2/5

**What went wrong:** Store methods wrapped a single call in `Effect.gen`, immediately `yield*`ed it, and returned nothing or the same result.

**What fixed it:** `409f856` passed the existing effect directly to the operation wrapper.

**Do this initially:** Use `Effect.gen` when it improves multi-step sequencing. For one effect, return or pipe it directly. The abstraction should make control flow clearer, not merely make code look more Effect-like.

### 15. Make service tags and service names precise — 3/5

**What went wrong:** Service identifiers claimed ownership by the wrong package, and “host” referred to a deployment target, remote address, MCP client, and integrations domain service. One-field wrapper services added naming without behavior.

**What fixed it:** `015fc1a` corrected package-qualified service IDs. `2aa4029` renamed `IntegrationHost` to `Integrations`, `McpHost` to `McpClient`, and flattened wrappers.

**Do this initially:** Give every service tag a globally unique identifier owned by its declaring package. Name a service after the capability it provides. Do not create a service whose only purpose is to wrap one identically scoped field.

## Implement-it-right-the-first-time checklist

1. Start with Schema domain models, branded identifiers, and tagged failure unions; derive all TypeScript types from them.
2. Keep application operations as `Effect<A, E, R>` end to end. Convert to Promise only at a real external boundary.
3. Define services and layers before orchestration. Provide dependencies once at the composition root and avoid nested runtimes.
4. Decode external data at entry points and translate typed domain failures at transport boundaries. Capture defects with enough context to diagnose them.
5. Scope every acquired resource and supervise background work. Use fibers and `Deferred`, never discarded Promise chains.
6. Use Effect platform capabilities first: `HttpClient`, `SqlClient`, `ChildProcess`, `HttpStaticServer`, `RateLimiter`, `Cache`, `Config`, `Crypto`, and `Encoding`.
7. Use `Clock`/`DateTime` for time, `Duration` for units, `Schedule` for in-process repetition, and `Random` for jitter.
8. Derive server and client behavior from one `HttpApi` definition, and keep that definition independent of server implementations.
9. Test with `@effect/vitest`, scoped fixtures, provided layers, `TestClock`, and fixed `ConfigProvider`s. Use live tests only for genuinely live boundaries.
10. Inspect the semantics of an Effect abstraction before adopting it—especially caching failures, rate-limiter algorithms, scope ownership, and stream/process lifetimes.
11. Keep exceptions deliberate: persisted retries may need database-owned state, and a truly detached daemon may need platform process APIs. Document the invariant, not the mechanics.
12. Remove redundant adapters, generators, wrappers, tests, and comments once the Effect model makes them unnecessary.
