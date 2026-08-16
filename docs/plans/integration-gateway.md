# Integration gateway — implementation plan

Turns the in-process integration host into a standalone gateway service with
thin CLI/TS/Python clients, without losing in-workflow integration use.

Design is settled in [CONTEXT.md](../../CONTEXT.md) and ADRs
[0001](../adr/0001-subjects-are-human-clients-are-delegated-to.md),
[0002](../adr/0002-grants-are-explicit-per-tool-rows.md),
[0003](../adr/0003-client-identity-binds-at-deployment.md). This plan does not
re-litigate those.

## End state

```
integrations CLI ─┐
Python client ────┼─► HTTP ─► Gateway ─► Executor ─► vendor
TS client ────────┤          ├─ key → client → grant → {subject, connection}
wf runtime ───────┘          ├─ policy: allow | require_approval
                             ├─ pending approvals
                             ├─ audit
                             └─ credentials (never leave)
```

One tenant per deployment. HTTP on `127.0.0.1` by default. One capability bit
per key gates catalog, connection, grant, and policy mutation.

## Package layout

Grouped by product rather than by kind:

| Path | Name | Contents |
|---|---|---|
| `apps/integrations/gateway` (new) | `@mokronos/integrations` | Gateway: domain, store, policy, approvals, audit, HTTP server. Depends on `@mokronos/wfkit-executor`. |
| `apps/integrations/ts` (new) | `@mokronos/integrations-client` | TS thin client + codegen. No dependency on the gateway package. |
| `apps/integrations/cli` (new) | `@mokronos/integrations-cli` | The `integrations` binary. Depends only on the client. |
| `packages/wfkit-executor` | unchanged | Becomes internal to the gateway. Nothing else imports it. |
| `packages/wf` | `@mokronos/wfkit` | Integration node speaks to the gateway via the client. |
| `apps/cli` | `@mokronos/wf` | Depends on `@mokronos/integrations-cli` so both binaries install together. |

A Python client (`apps/integrations/python`) is deferred until the TS and CLI
clients have been used in anger. Moving `apps/cli` → `apps/wf/cli` and
`apps/web` → `apps/wf/web` for symmetry is deferred too: it churns the build
scripts, embedded-asset generation, publish scripts, and the hardcoded paths in
`packages/wf/test/architecture.test.ts` for no functional gain.

Nested workspaces mean the root `workspaces` glob needs `apps/*/*` alongside
`apps/*`.

The CLI depending only on the client is deliberate: it makes "thin client" a
structural property rather than a convention. Admin operations go over HTTP
like everything else.

### On `wf i`

The **capability** is not lost — every current `wf i` subcommand reappears on
the `integrations` binary, which installs alongside `wf` via the package
dependency. What phase 3 deletes is the *implementation* inside `apps/cli`, so
there is one argument parser over one API rather than two that can drift. A
`wf i` alias that shells out to `integrations` can be added later if the muscle
memory is worth it.

**Consequence worth flagging early:** the OAuth callback server currently lives
in `apps/cli/src/cli/oauth.ts`. It moves to the gateway, because the gateway is
what holds credentials. The CLI opens a browser and polls for completion.

## Phases

Each phase is independently shippable and leaves the repo green.

---

### Phase 0 — Scaffold, no behaviour change

Create `apps/integrations/gateway` depending on `@mokronos/wfkit-executor`, and
give it ownership of storage-directory resolution and host composition.
`apps/cli` imports the new package instead of `wfkit-executor` directly.

- New: `apps/integrations/gateway/src/{index,paths,host}.ts`
- Changed: root `workspaces` gains `apps/*/*`; root tsconfig `paths` gains the
  new package; `apps/cli/src/main.ts` imports
- Storage dir: the gateway owns resolution and reads `INTEGRATIONS_HOME` first,
  falling back to `WF_HOME` and then `~/.wf`, so nothing moves on disk

`default-host.ts` stays where it is — `auth`, `catalog`, `tools`,
`connections`, and `invoker` all import `runExecutor` from it, so moving it is
a phase unto itself and buys nothing yet. The gateway composes hosts explicitly
via `createExecutorHost`, matching the constraint in
`packages/wf/test/architecture.test.ts` that nothing mutates global storage
state.

**Done when:** every existing `wf i` command behaves identically, and
typecheck and tests pass unchanged.

---

### Phase 1 — Gateway domain and store

The second store from ADR 0001, in-process only. No HTTP yet.

Effect Schema definitions (single source of truth, TS types derived), branded
ids for `ClientId`, `GrantId`, `ApprovalId`, `Alias`:

- `Client` — id, name, `mayMutate: boolean`, `revokedAt`
- `ApiKey` — id, clientId, hash, `revokedAt`; several may be live per client
- `Grant` — id, clientId, alias, connection ref, tool, `decision: "allow" | "require_approval"`, `revokedAt`
- `PendingApproval` — id, clientId, grantId, frozen arguments, `expiresAt`, decision, decidedBy
- `AuditRecord` — client, alias, connection, subject, tool, decision, outcome, timestamp
- `AuditArguments` — separate row, separately expirable (ADR: retention differs)
- `CatalogSnapshot` — per connection, the recorded tool shape for drift

Plus the resolution path: `key → client → grant → {subject, connection, tool, decision}`.

- New: `packages/integrations/src/domain/*.ts`, `packages/integrations/src/store/*.ts`
- Store: its own sqlite in the storage dir, alongside Executor's

**Done when:** resolution is unit-tested end to end — including that a revoked
key denies, a revoked client denies, an ungranted tool is absent from listing,
and address-invocation resolves then grant-checks (ADR 0002).

---

### Phase 2 — HTTP server

Effect `HttpApi` (the current dashboard is `if`-chains over `Bun.serve`; this
is the point to stop doing that). Bearer key auth, `127.0.0.1` default, TLS
required when bound externally.

Delegated surface (any key):
- `GET /v1/tools` — the caller's granted tools, aliases and schemas
- `POST /v1/execute` — `{alias, tool, arguments}`
- `GET /v1/approvals/:id` — poll a pending approval

Privileged surface (`mayMutate` keys only):
- integrations: search, discover, list, tools, schema
- connections: connect, list, disconnect; OAuth start/callback/complete
- grants, clients, keys: create, list, revoke
- audit and drift reads

- New: `packages/integrations/src/http/*.ts`, `packages/integrations/src/daemon.ts`
- Config file in the storage dir carrying port + local key, env var override

**Done when:** a `mayMutate: false` key gets 403 on every privileged route, and
the dashboard's existing `/api/integrations` view still renders.

---

### Phase 3 — TS client and the `integrations` CLI

The client is deliberately dumb: auth, HTTP, decode. All ten current `wf i`
subcommands reappear on the `integrations` binary — `discover`, `search`,
`list`, `tools`, `schema`, `connect`, `connections`, `disconnect`, `invoke`,
`validate` — plus `grant`, `client`, `key`, `approve`, `audit`, `drift`.

- New: `apps/integrations/ts/src/*.ts`, `apps/integrations/cli/*`
- Changed: `apps/cli/package.json` gains the dependency; the `wf i`
  implementation moves out of `apps/cli/src/cli/integrations.ts`
- OAuth: browser-open + poll in the CLI; callback server in the gateway

**Required: progressive output parity.** `9f098b9` added progressive output by
default across the integrations commands — a `--verbose` flag on every
subcommand, listings bounded to a page with a `Showing N of M. Rerun with
--verbose for all.` hint, compact JSON unless verbose, and truncated tool
schemas with a `details: rerun with --verbose` line. `16a656b` reverted all of
it while doing unrelated executor work. It was restored in
`apps/cli/src/cli/main.ts` but deliberately **not** in
`apps/cli/src/cli/integrations.ts`, because that file is replaced here. The new
CLI must reintroduce it, and the `--verbose` assertion removed from
`apps/cli/test/cli-help.test.ts` must come back with it.

**Done when:** `integrations` reproduces every current `wf i` behaviour
including `--text` rendering and the `next:` hint lines, and `npm i -g
@mokronos/wf` installs both binaries.

---

### Phase 4 — Approvals, audit, drift

- `require_approval` grants freeze arguments and return `{status: "pending", id}` — never block (Q18)
- Expiry is terminal: the invocation does not happen
- `integrations approve <id>` / dashboard approval view
- Revoking a *client* cancels its pending approvals; revoking a *key* does not
- Audit written for every attempt; arguments in a separate expirable row
- Catalog refresh diffs against `CatalogSnapshot`, reports added/removed/changed
- Output-schema mismatches recorded as drift, not failures

**Done when:** an approved invocation is performed *by the gateway* and the
caller retrieves the result without ever having gained the capability itself.

---

### Phase 5 — `wf` migration

The riskiest phase, and the one that breaks the authoring surface.

- `IntegrationSource` becomes alias-based only. Delete `LegacyIntegrationSource`,
  the address branch in `integrationSourceKey`, and the name-preservation logic
  in `integration()`
- `IntegrationInvoker` implemented over `@mokronos/integrations-client`
- Delete the hand-transcription path: `integration({input, output})` takes
  generated Effect Schema
- `wf validate` checks declared aliases against the configured key's grants,
  replacing the ambiguous-resolution error
- Update `examples/*`, `packages/wf/skills/wf/SKILL.md` and
  `references/authoring.md`
- Delete the stale `.wf/*.sqlite` scratch databases

**Done when:** `examples/connected-case` runs against a live gateway, and a
daemon restart mid-run is ridden out by retry rather than failing the run.

---

### Phase 6 — Codegen

- `integrations codegen --target {ts,effect}` against the caller's own gateway,
  emitting only tools the key can reach
- Effect target reuses `ExecutorTool.typeScriptDefinitions`

Phase 5 depends on the `effect` target, so that half lands with the migration;
the `ts` target for plain client use is what remains here.

**Done when:** `integrations.gmail.search(...)` type-checks and the generated
surface equals the grant surface.

### Deferred — Python client

`apps/integrations/python`, mirroring the TS client plus a
JSON-Schema-to-Pydantic codegen target. Held until the TS and CLI clients have
been used enough to know what the shape should be.

## Open items deliberately deferred

- **Org-tier delegation is ungated.** Any subject may delegate the shared
  credential. Revisit when someone joins the tenant who should see the catalog
  but not delegate it.
- **Multi-user hosted runner.** One runner serving many users breaks the
  deployment-time binding in ADR 0003 and needs per-run subject binding.
- **Multi-tenancy.** One tenant per deployment; Executor already carries
  `tenant` everywhere, so this is a scoping key when needed.
- **Approval expiry default.** Needs a number; not a design decision.

## Sequencing notes

Phases 4 and 5 are independent and can swap. Phase 5 must not start before
phase 3 ships, since it depends on the client package. Phase 6 depends only on
phase 3.
