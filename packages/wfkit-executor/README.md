# @mokronos/wfkit-executor

The local Executor-backed integration host for `@mokronos/wfkit`.

It owns Executor construction, local persistence, encrypted credentials,
integration discovery, connections, tool schemas, OAuth primitives, and tool
invocation. Workflow authoring remains in `@mokronos/wfkit`.

Applications should create one `ExecutorHost`, derive `ExecutorServices` from it,
inject `services.integrationInvoker` into the workflow runtime, and close the host
at shutdown. The services delegate URL detection, auth metadata, OAuth/PKCE,
integration metadata, and input/output schema discovery to `@executor-js/sdk`.
