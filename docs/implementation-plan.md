# Historical: core wrapper implementation plan

> **Status:** Completed planning record. For the current API, use the
> [TypeScript SDK documentation](../apps/docs/docs/wfkit.md). This document
> preserves implementation rationale and does not describe the current scope.

Target: implement the `docs/spec.md` API as a wrapper over `@effect/workflow`, plus the
handful of operational primitives that competitor research showed cannot be layered on later
(cancel, signal buffering, actor metadata, secret references, concurrency limits). Everything
else — triggers/webhooks/cron dispatchers, connectors, UI, RBAC/SSO, task-inbox service,
visualizations — is platform and explicitly **out of scope**.

## Summary of decisions

1. **Authoring model**: `defineStep` (input/output/errors schemas, plain-async `execute`,
   colocated `compensate`, retry policy) + `defineWorkflow` (generator
   `run`) + `ctx.run(step, input)` with automatic per-step invocation counters. This replaces
   the current `ctx.activity(name, fn, opts)` model in `packages/wf/src/core.ts`.
2. **Error taxonomy**: thrown/undeclared = transient = retried per policy; `step.fail(...)` /
   `ctx.fail(...)` = typed terminal = no retry, propagates, unwinds compensation LIFO.
3. **Execution identity**: every `client.start()` is a fresh execution (random ID); dedup only
   via explicit `idempotencyKey`. This replaces the current deterministic hash-of-input run IDs
   in `packages/wf/src/sdk/sdk.ts`.
4. **Determinism**: `ctx.now()` / `ctx.random()` recorded and replayed; replay-divergence
   detector fails loudly with `NonDeterminismError` instead of silently corrupting state.
5. **Signals**: typed payload via schema, timeout as a typed *outcome* (business branch, not
   exception), and **buffering** — a signal delivered before the workflow reaches
   `waitForSignal` must not be lost.
6. **Promoted from "platform" into core** (they change engine semantics or persistence
   formats, so they go in now): `client.cancel()` with compensate-or-kill semantics; actor
   metadata on start/signal/cancel recorded in history; secret *references* (never values) in
   step payloads; per-step concurrency/rate keys.
7. **HITL** needs no new primitive: it is `ctx.run(notifyStep)` + durable
   `ctx.waitForSignal(..., { timeout })`. Buffering + signal auth/audit (actor metadata) make
   it production-grade. Task-inbox service/UI is platform, later.

## Deferred (do not build)

`ctx.all` fan-out, child workflows, continue-as-new / history truncation, workflow migration,
custom backoff beyond `attempts`/`"exponential"`, trigger dispatchers
(webhook/cron/polling — they compose on top of `client.start` + `idempotencyKey`), task-inbox
records, any UI. `DurableQueue` etc. remain reachable via the `ctx.effect` escape hatch.

## Current substrate (keep, refactor in place)

- `packages/wf/src/core.ts` — ctx + defineWorkflow (will be largely rewritten).
- `packages/wf/src/runtime.ts` — SQLite-backed `@effect/cluster` engine layer (keep).
- `packages/wf/src/events.ts` — event emission (extend with new event types + actor).
- `packages/wf/src/errors.ts` — `defineError` (subsumed by step/workflow `errors` schemas;
  keep as sugar or fold in).
- `packages/wf/src/signal.ts` — `defineSignal` (replaced by named+typed signals on ctx).
- `packages/wf/src/sdk/*` + `apps/cli` — catalog/run SDK.
- `packages/wf/test/mock-fixtures.test.ts` — replace/extend with per-phase tests below.

---

## Phase 1 — Authoring model: `defineStep`, new `defineWorkflow`, `ctx.run`

The foundation; everything else depends on it. Rewrite `core.ts` around the spec shapes
(spec §1–§3).

- `defineStep({ name, input, output, errors?, execute, compensate?, retry? })` returning a
  `Step<I, O, E>` object carrying its schemas and metadata.
  - `execute: (input, step) => Promise<O | TerminalFailure<E>>` — plain async, no Effect
    knowledge. `step` is `StepContext`: `{ fail(e), attempt, executionId }`.
  - Lift into `Activity.make` internally: transient errors (anything thrown) go to a retryable
    channel; `step.fail(e)` values are validated against `errors` schema and map to the typed
    terminal channel (Effect error channel with the declared schema).
  - `retry: { attempts, backoff: "exponential" | "none" }` applies to transient errors only.
- `ctx.run(step, input)`:
  - Maintains a per-execution `Map<stepName, count>` in ctx; the underlying activity name is
    `` `${step.name}#${n}` ``. Counters are rebuilt identically on replay because the body
    re-executes deterministically. **This is the wrapper's most important behavior** — same
    step twice or in a loop never replays a stale persisted result.
  - Decodes input / encodes output through the step's schemas before persistence.
  - Attaches `compensate` via `Workflow.withCompensation` at the call site, wrapping it so it
    receives `(result, input, reason)`.
- New `defineWorkflow({ name, input, output, errors, run })` (spec §2).
- `ctx.fail(error)` — typed against workflow `errors`, terminal, triggers LIFO unwind of every
  completed step's compensation.
- `ctx.sleep(duration, name?)` — keep `DurableClock.sleep`; apply the same invocation-counter
  rule when `name` is omitted or repeated.
- `ctx.effect(effect)` — escape hatch, raw Effect passthrough.
- Keep the current pure `ctx.step(description, fn)`? **No** — rename concern: spec has no
  non-durable annotated step. Drop it from the public surface for now (pure inline TS between
  `yield*`s covers it); revisit if the diagram layer needs it.
- Events: emit `step.started/completed/failed`, `compensation.started/completed/failed` with
  step name + invocation counter.

Acceptance:
- A ported `OrderWorkflow` matching spec §2 typechecks with full inference: `ctx.run` result
  typed from `output`, `ctx.fail` constrained to `errors` union.
- Test: calling one step twice and in a 3-iteration loop persists 5 distinct results.
- Test: thrown error retries `attempts` times then becomes terminal; `step.fail` never retries.
- Test: terminal failure after 2 successful steps runs compensations LIFO with
  `(result, input, reason)` args; steps without `compensate` are skipped.

## Phase 2 — Determinism: `ctx.now`, `ctx.random`, replay-divergence detector

- `ctx.now(): WorkflowValue<Date>` and `ctx.random(): WorkflowValue<number>` implemented as
  internal micro-activities (named `now#n` / `random#n` via the same counter mechanism) so the
  value is recorded on first execution and replayed thereafter.
- Replay-divergence detector (spec §5): ctx records the ordered sequence of orchestration
  calls `(kind, name, counter)` — steps, sleeps, signals, now/random — in its own durable
  journal (extend the events store or a dedicated table). On replay, each ctx call compares
  its position against the recorded entry; mismatch fails the execution with
  `NonDeterminismError` naming the expected vs. actual call. Detection happens at call time,
  before executing anything.

Acceptance:
- Test: workflow using `ctx.now`/`ctx.random` produces identical values across a
  crash-and-resume (kill the engine mid-run between steps, restart, resume).
- Test: simulate divergence (register an execution's history, replay against a body with a
  reordered/renamed step) → `NonDeterminismError` naming the step; no state written.

## Phase 3 — Signals: typed payloads, timeout-as-value, buffering

Replace `signal.ts`'s bare `defineSignal`/`DurableDeferred` usage.

- `ctx.waitForSignal(name, schema, { timeout? })` returning
  `{ type: "signal", value: T } | { type: "timeout" }` — race the durable deferred against a
  durable timer; timeout is a value, never a thrown error. Signal payload decoded against
  `schema` (delivery-side validation too — reject bad payloads at `client.signal` time).
- **Buffering**: a signal delivered before the workflow reaches its `waitForSignal` must be
  retained (per execution + signal name, FIFO if multiple) and consumed on arrival at the wait
  point. Verify whether `DurableDeferred` already gives this (succeed-before-await persists);
  if not, add a small signal-buffer table keyed by `(executionId, signalName)`.
- Same invocation-counter rule for repeated waits on the same signal name (enables the
  reminder loop: wait 24h → timeout → send reminder step → loop).
- Events: `signal.waiting`, `signal.received` (with payload), `signal.timeout`.

Acceptance:
- Test: HITL shape from spec §2 — approve within timeout → completes; no signal → timeout
  branch → `ctx.fail` → compensation runs.
- Test: signal sent *before* the workflow reaches `waitForSignal` is not lost.
- Test: reminder loop — 3 timeouts then a signal; 3 reminder steps persisted with distinct
  counters.
- Test: payload failing schema validation is rejected at delivery and does not resume the
  workflow.

## Phase 4 — Client: start/signal/result/status/list/history/cancel + actor metadata

Rework `packages/wf/src/sdk/sdk.ts` into `createWorkflowClient()` (spec §4).

- `start(workflow, payload, opts?)` — **fresh random execution ID by default**; explicit
  `opts.idempotencyKey` opts into at-most-once (same key → same execution). Returns a handle
  `{ executionId }`. Remove the hash-of-input run IDs.
- `signal(executionId, name, payload, opts?)` — validates against the wait's schema, buffers
  per Phase 3.
- `result(executionId)` — blocks until terminal; returns
  `{ type: "completed", value } | { type: "failed", error }` with the typed error decoded.
- `status(executionId)` — non-blocking:
  `"running" | "suspended" | "completed" | "failed" | "compensating"`. `suspended` = parked on
  a durable sleep or signal wait; `compensating` = terminal failure occurred, unwind running.
- `list(workflow, { status?, limit?, cursor? })` — filtered, cursor-paginated.
- `history(executionId)` — ordered typed events (step-started/completed/failed,
  compensation-run, slept, signal-received, cancelled, …) with payloads. Builds on `events.ts`.
- **`cancel(executionId, { compensate: boolean })`** — new engine semantic:
  - `compensate: true` (default): interrupt the workflow fiber at the next suspension point,
    then run the compensation stack for completed steps, terminal status `"failed"` with a
    `Cancelled` error.
  - `compensate: false`: hard interrupt, no unwind (operator "kill switch").
  - A currently-executing activity finishes or is interrupted per `@effect/workflow`'s
    interrupt support — investigate `WorkflowEngine.interrupt`; document what happens
    mid-activity.
- **Actor metadata**: `start`/`signal`/`cancel` accept optional `{ actor: string }`, recorded
  on the corresponding history events. Cheap now, painful to retrofit.

Acceptance:
- Test: two `start`s with identical payload → two executions; same `idempotencyKey` → one.
- Test: cancel during a signal wait with `compensate: true` runs the LIFO unwind; with
  `false` it doesn't; both appear in `history` with actor.
- Test: `status` transitions observed across a full run incl. `suspended` during sleep.

## Phase 5 — Test runtime

`createTestRuntime()` in a new `packages/wf/src/testing/` module.

- In-memory engine (memory variant of the runtime layer in `runtime.ts` — no SQLite file, no
  cluster), plus in-memory event/journal stores.
- `rt.mockStep(step, impl)` — swaps the step's `execute` by step identity inside `ctx.run`;
  mocks participate in the normal transient/terminal taxonomy (a throwing mock is retried).
- `rt.failStepOnce(step)` — retry-path helper.
- `rt.recordCompensations()` — returns a recorder with ordered `calls: { step, result }[]`.
- Time skipping: `timeSkipping: true` default (durable sleeps + signal timeouts auto-elapse);
  `rt.advanceTime("1 hour")` for manual control (Effect `TestClock` under the hood if the
  durable timer implementation permits, otherwise a virtual clock in the memory engine).
- `rt.start`, `rt.sendSignal`, `rt.result` mirroring the client API.

Acceptance: the exact test from spec §6 passes verbatim. Also: divergence detector and
cancel are exercisable in the test runtime (they're needed to test real workflows).

## Phase 7 — Operational core: concurrency keys & secret references

Last because both are additive to the Phase 1 step model.

- **Concurrency/rate limits per step**: `defineStep({ ..., concurrency?: { key?: (input) =>
  string, limit: number } })` — engine-side keyed semaphore so N executions calling the same
  step don't stampede a rate-limited API. Initial scope: in-process semaphore in the engine layer
  (documented as per-node, not distributed); the API shape is the commitment, the distributed
  implementation can come later.
- **Secret references**: a `SecretRef` schema/marker (`secret("stripe-key")`) usable in step
  inputs. Serializes as the reference string only; resolved to the value inside `execute` via
  a resolver provided at bootstrap (`createWorkflowRuntime({ secrets })`). Guarantee: the
  secret value never appears in persisted payloads, events, or `client.history()`.

Acceptance:
- Test: 10 concurrent executions of a `limit: 2` step never exceed 2 in flight.
- Test: a workflow passing a `SecretRef` through a step — `history()` and the SQLite rows
  contain only the reference; `execute` received the resolved value.

---

## Delegation notes

- Phases are ordered by dependency: 1 → 2 → 3 can be one work stream; 4 and 5 depend on 1 but
  not on 2/3 (except `cancel`'s compensation semantics, which need Phase 1's unwind); 6 needs
  1–5's surfaces to exist; 7 is independent after 1.
- Every phase must keep `bun test` green and port `apps/cli` + the example workflow
  (`examples/`) to the new surface as it changes — the CLI is the smoke test.
- The spec (`docs/spec.md`) is the source of truth for API shapes; where this plan and the
  spec conflict, the spec wins, and additions here (cancel, buffering, actor, secrets,
  concurrency) should be folded back into the spec as they land.
- Key `@effect/workflow` capabilities to verify early (spike in Phase 1): activity naming
  constraints (are `#` suffixes legal), `Workflow.withCompensation` semantics on partial
  failure, `WorkflowEngine.interrupt`, and whether `DurableDeferred` persists a
  succeed-before-await (determines Phase 3's buffering approach).
