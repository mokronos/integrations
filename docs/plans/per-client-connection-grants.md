# Per-client connection grants

Restores ADR 0001's intersection — "aliases and credential-bearing connection
bindings remain client-specific" — at **connection** grain, which is the grain
0001 was reaching for when it rejected per-tool grants as unmanageable.

## The model

- **Connection** — unchanged. `(owner, integration, name)`, born wired to one
  integration. Tenant-wide.
- **Grant** (new) — `(client, connection) -> alias`. Client-specific. Says
  *which credentials this client reaches and what it calls them*. Resurrects
  the `grant` name that `store.ts:1092` renamed away.
- **Policy** — rules at connection grain, `(policy, connection, tool) ->
  enabled, decision`. Shared. Says *how a client may use whatever it reaches*.
- **Effective tools** = live grants ⋈ enabled rules on the same connection.
  Alias from the grant, decision from the rule.

A rule for a connection the client has no grant for is **inert** — hidden, not
an error, consistent with the existing `not-authorized` opacity in
`authorize.ts:68`.

One shared policy with rules for `linear1, linear2, gmail, slack` assigned to
three clients granted different subsets yields three different surfaces with no
interference. That is the point.

### Two consequences

**Default-policy auto-join becomes safe and is kept.** It is only alarming
today because a rule *is* access. Once a rule grants nothing without a grant,
the default policy absorbing every newly connected credential just means "if
someone grants you this, it will work."

**The alias stops being derived.** It is stored on the grant, allocated once,
and never recomputed. `routeAliases` (`connected-bindings.ts:128-146`) is
deleted. Deriving from the client's connection set instead of the policy's
would shrink the blast radius but keep the bug: granting a client its second
Linear would still rename its first.

The grant is a better home than a policy row because the alias is client-facing
and the policy is shared — storing it on the policy would force every client on
that policy to call one connection by the same name.

## Alias allocation

At grant time, per client:

1. The integration slug (`linear`).
2. If a live grant of that client holds it, `<slug>-<connection_name>`.
3. Then `<slug>-<connection_name>-2`, `-3`, …

First-come-first-served, stable for the life of the grant. Renaming is an
explicit `PATCH` on the grant — the only path that changes a client's tool
names.

## Auto-seed with copy-on-write fork

Granting connection `C` to client `K` on policy `P`, where `P` has no rule for
`C`:

| Case | Behavior |
| --- | --- |
| `P` is the default policy | Rules already exist via auto-join. No-op. |
| `P` has exactly one assigned client (`K`) | Seed rules into `P` in place. Nobody else is affected, so a fork buys nothing. |
| `P` is genuinely shared | Fork `P` -> `P'`, copy every rule, reassign `K` to `P'`, seed `C`'s rules into `P'`. |

A rule that exists but is `enabled = false` counts as present — the operator
made a decision; do not seed over it and do not fork.

**Flag:** a fork permanently detaches `K` from later edits to `P`, which is the
exact benefit a shared policy was providing. Mitigations, all in scope here:
fork only when actually shared (the table above), add
`gateway_policy.forked_from` for provenance, show a "forked from P" badge on
the policy and on the client detail page, and surface the fork in the grant
response and dashboard toast rather than letting it happen silently.

## Schema

**New `gateway_client_connection_grant`**

```sql
id TEXT PRIMARY KEY,
tenant_id TEXT NOT NULL REFERENCES gateway_tenant (id) ON DELETE CASCADE,
client_id TEXT NOT NULL REFERENCES gateway_client (id) ON DELETE CASCADE,
owner TEXT NOT NULL,
subject TEXT,
integration TEXT NOT NULL,
connection_name TEXT NOT NULL,
alias TEXT NOT NULL,
created_at INTEGER NOT NULL,
revoked_at INTEGER
```

Two partial unique indexes, both `WHERE revoked_at IS NULL`, following the
`COALESCE(subject, '')` convention already used at `store-ddl.ts:114`:

- `(client_id, owner, COALESCE(subject, ''), integration, connection_name)` — one grant per credential per client.
- `(client_id, alias)` — aliases are unique within a client.

**Dropped: `gateway_policy_integration`.** A connection-grain rule row *is* the
membership; `enabled = false` is "remembered but off". The integration
membership AND-gate at `authorize.ts:59` and `invoke.ts:316` disappears.

**`gateway_policy`** gains `forked_from TEXT REFERENCES gateway_policy (id)`.

**`gateway_pending_approval`** repoints from `binding_id` to `grant_id`, keeping
its existing `tool` column. The retry index becomes
`(policy_id, grant_id, tool, arguments_lookup, arguments)`. This is the durable
win: a grant survives policy edits, so editing an unrelated rule no longer
orphans in-flight approvals.

**`gateway_client_tool_binding`** is gone. Nothing references it: approvals
moved to `grant_id` and audit was already denormalised.

**`gateway_audit`** unchanged — it denormalizes alias/owner/subject/integration/
connection/decision and holds no binding FK.

### No migration

`AGENTS.md` rules out hand-written migrations and backwards-compatibility code
while the project is this young, so the schema is declared once in
`store-ddl.ts` and created as declared. Changing a shape means deleting the
database. `ensureSchema` now runs the DDL and writes the default tenant and its
default policy — nothing else.

## Touchpoints

**`packages/core/gateway`**
- `store-ddl.ts` — grant table, indexes, approval repoint, drop membership.
- `store.ts` — `ConnectionGrant` row codec, `listGrants` /
  `createGrant` / `revokeGrant` / `renameGrantAlias`, remove
  `listPolicyIntegrations`, update `replacePolicyConfiguration`.
- `domain.ts` — `ConnectionGrant` schema; delete `PolicyIntegration` and
  `ClientToolBinding`; `Authorization` carries the grant.
- `connected-bindings.ts` — replaced by `grants.ts`. Deleted `routeAliases`,
  `synchronizeClientBindings`, `synchronizeAssignedPolicyBindings`,
  `synchronizeTenantBindings`. `reconcilePolicyConfigurations` keeps only the
  default-policy branch and drops the "policies holding this integration absorb
  the new connection" branch at `:89`. `forgetConnectionRules` additionally
  revokes grants for the deleted connection.
- `authorize.ts:55-83` — resolve by `(client, alias, tool)` against grants, then
  intersect with the enabled rule for that grant's connection.
- `invoke.ts:307-331` — `listEffectiveTools` becomes grants ⋈ rules.

**`packages/core/api`**
- `api.ts` — `PolicyIntegration` -> connection-grain contracts;
  `integrationCount` -> `connectionCount`; `replacePolicyTools` payload takes
  `connections: ConnectionRef[]`; new grant endpoints.
- `handlers/administrative.ts` — policy summary/detail/clone at connection
  grain; the fork-on-seed rule.
- `handlers/provisioning.ts:287` — `i connect` by a client holding
  `provision_connections` auto-grants to that client. Operator-created
  connections do **not** auto-grant.
- New: `POST|DELETE /v1/clients/:id/connections`, `PATCH` for alias.

**`apps/web`**
- `components/policies/policy-editor.tsx` — "Add integration" (`:341`) and
  "Remove integration" (`:335`) become connection-grained, with per-integration
  bulk add-all / remove-all. Cards still group by integration for display.
- `routes/policies.tsx:47`, `routes/client-detail.tsx:51` — counts.
- `routes/client-detail.tsx` — new Connections section: grants, aliases, rename,
  revoke, and a "granted, but the policy has no rules for this connection"
  state.
- `lib/schemas.ts`, `lib/gateway.ts`, `lib/queries.ts`.

**`apps/cli`**
- `commands/connections.ts` — `i connect` reports the grant and its alias.
- `commands/delegation.ts:295` — `policy-tool` payload at connection grain; new
  grant commands.

**Docs**
- New ADR recording connection-grain grants, the stored alias, and
  copy-on-write forking. Cross-reference 0001 as the decision being restored
  rather than superseded.

## Tests

Existing suites that will need to move with this: `gateway/test/authorize.test.ts`,
`gateway/test/policy.test.ts`, `gateway/test/store.test.ts`,
`api/test/policy-http.test.ts`.

New coverage worth writing:

- Granting a client a second connection for the same integration leaves the
  first alias untouched.
- A rule for an ungranted connection is invisible in `listEffectiveTools` and
  yields `not-authorized` on invoke.
- Connecting a new credential adds rules to the default policy and grants
  nothing to any client.
- Fork-on-seed: shared policy forks and leaves siblings untouched;
  single-client policy is edited in place; default policy does neither.
- A fresh database opens with the declared schema, a default tenant, and that
  tenant's default policy.

## Built

Landed as described, with these deviations worth recording:

- The binding table is **dropped**, not retained. Keeping it would have meant
  carrying a table nothing reads.
- `reconcilePolicyConfigurations` became `reconcileDefaultPolicy` — with custom
  policies no longer absorbing anything, the default policy is the only thing
  left to reconcile, and the function says so.
- **Every migration was removed**, not just the ones this change would have
  added. The first attempt wrote a `migrateBindingsToGrants` step and
  immediately hit the trap those steps set: `ensureSchema` runs on every open,
  so `migratePolicies` recreating the binding table resurrected it after the
  new step retired it, and the next open read a `binding_id` column that no
  longer existed. Per `AGENTS.md`, the pre-existing tenancy, legacy-policy-tool
  and legacy-grant migrations went too. A shape change now means deleting the
  database.

Decided during implementation: a fork happens only when the policy is genuinely
shared. A policy with one assigned client, or the tenant default, is edited in
place — there is nobody to protect, and forking would only produce clutter.

See `docs/adr/0002-clients-hold-connection-grants-with-stable-aliases.md`.
