# Subjects are human; clients are delegated to

Executor binds an executor instance to a single `{tenant, subject}` pair, but a
call has two identities behind it — the person whose Gmail is being read, and
the agent reading it. We put the **human** in the subject slot and model
clients (agents, workflow runners, CLIs, scripts) as a separate axis that holds
no connections of its own, reaching tools only through grants. The alternative,
making each agent a subject, would have forced every agent to complete its own
OAuth consent for the same account and left N connections to hunt down when one
person's access is revoked.

## Consequences

- Executor's built-in `ToolPolicy` cannot carry our authorization decisions. It
  is keyed by `(tenant, owner, subject)` — the connection axis — so it can
  express "Sebastian's rules" but not "the sales-campaign agent's rules". We own
  the per-client layer; Executor's org-tier policies remain usable as a
  tenant-wide floor, composing under its existing most-restrictive-wins rule.
- Clients, API keys, and grants cannot live in Executor's tables. Resolving a
  grant is what *determines* the subject to bind, so it must happen before an
  executor instance exists. The gateway owns a second store above Executor's,
  and the request flow is: key → client → grant → `{subject, connection}` →
  construct executor → invoke.
- "Acting on behalf of" is never carried in the API key. It is derived per
  invocation from whichever connection the grant resolves to, which is why the
  key needs no user claim.
