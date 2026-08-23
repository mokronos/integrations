# @mokronos/integrations-executor

The gateway's internal Executor-backed integration host.

It owns Executor construction, local persistence, encrypted credentials,
integration discovery, connections, tool schemas, OAuth primitives, and tool
invocation. It has no dependency on a workflow runtime.

The gateway creates one `ExecutorHost`, derives `ExecutorServices` from it, and
closes the host at shutdown. The services delegate URL detection, auth metadata,
OAuth/PKCE, integration metadata, and input/output schema discovery to
`@executor-js/sdk`.
