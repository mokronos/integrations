# @mokronos/integrations

The integration gateway. Holds connections and credentials, resolves grants,
decides authorization policy, and performs invocations — so callers hold only
what they were granted and never a credential.

Vocabulary is defined in [CONTEXT.md](../../../CONTEXT.md). The architecture is
recorded in
[ADR 0001](../../../docs/adr/0001-subjects-are-human-clients-are-delegated-to.md),
[ADR 0002](../../../docs/adr/0002-grants-are-explicit-per-tool-rows.md), and
[ADR 0003](../../../docs/adr/0003-client-identity-binds-at-deployment.md), with
the build sequence in
[docs/plans/integration-gateway.md](../../../docs/plans/integration-gateway.md).

## Status

Phase 0 — scaffolding. The package owns storage-directory resolution and
gateway composition over Executor. The domain store, HTTP surface, policy, and
approvals are not built yet.

## Storage

`INTEGRATIONS_HOME`, falling back to `WF_HOME`, then `~/.wf`. The directory
holds Executor's catalog and sealed credentials, and will hold the gateway's
own store (`gateway.sqlite`) from phase 1.
