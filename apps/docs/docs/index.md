# wf documentation

`wf` is an agent-first workflow platform. An agent designs the workflow; a small,
boring runtime executes it for years. What you keep is a repeatable, typed
artifact — plain TypeScript in a file you can read — not an expensive LLM
execution trace.

Execution is durable: every step result, timer, and signal wait is persisted in
SQLite, so runs replay deterministically and survive process restarts.

## The four surfaces

| Surface | Package | What it is |
| --- | --- | --- |
| `wf` CLI | `@mokronos/wf` | Create, validate, run, signal, and inspect workflows; serves the local dashboard |
| TypeScript SDK | `@mokronos/wfkit` | The authoring API (`defineStep`, `defineWorkflow`, `integration`, `t`) plus the embeddable runtime and test helpers |
| `integrations` CLI | `@mokronos/integrations-cli` | Discover, authorize, delegate, and invoke external systems through the gateway |
| Gateway client | `@mokronos/integrations-client` | The thin TypeScript client a delegated caller uses to reach granted tools |

The gateway itself (`@mokronos/integrations`) is the only component that ever
sees a credential. Workflows and clients hold names, not secrets.

## Install

```bash
bun install -g @mokronos/wf
```

`npm install -g`, `pnpm add -g`, and `yarn global add` also work. The installed
`wf` command is a standalone platform binary — you do not need Bun to run it.

The `integrations` command (and its short alias `i`) ships in
`@mokronos/integrations-cli`, a dependency of `@mokronos/wf`. It runs from
source and needs Bun on the machine.

> **Release status.** `@mokronos/wf` and `@mokronos/wfkit` are on npm at 0.2.0.
> `@mokronos/integrations-cli` and `@mokronos/integrations-client` are not
> published yet, and the published `wf` predates the gateway split documented
> here — it still carries integrations as `wf i ...` subcommands. Until the next
> release, get the current surface from the repository:
>
> ```bash
> git clone https://github.com/mokronos/wf && cd wf
> bun install && bun run install:local   # installs wf, integrations, and i
> ```

State lives under `~/.wf` by default. Set `WF_HOME` (or `INTEGRATIONS_HOME` for
the gateway's half) to use another directory.

## First run

### 1. Create a workflow

With no source, `wf create` writes a small starter workflow into the catalog, so
you reach a run without writing a file first:

```bash
wf create hello
```

```text
Created hello	HelloWorkflow#HelloWorkflow	/home/you/.wf/workflows/hello.ts
```

That path *is* the workflow. Editing the file changes what the next run
executes, so an agent can patch a workflow with ordinary file tools and run it.
`wf create --file ./workflow.ts` imports your own file instead. A file exporting
several workflows needs `export default` to say which one `wf run` executes.

### 2. Validate it

`wf validate` loads the workflow, resolves its exported definition, and traces
its body in memory with sample inputs and faked steps. Nothing is executed for
real and no durable run is started:

```bash
wf validate hello
```

```text
Valid hello	HelloWorkflow#HelloWorkflow
input: {"type":"object","properties":{"message":{"type":"string"}},"required":["message"],"additionalProperties":false}
output: {"type":"null"}
flow:
  step	PrintMessage activityName="PrintMessage#1" compensates=false
```

That is the whole feedback loop for an agent: the input schema it must satisfy,
the output schema it can rely on, and the ordered flow of orchestration calls it
just authored. A broken workflow exits non-zero and prints why.

### 3. Run it

```bash
wf run hello '{"message":"hello from wf"}'
```

```text
[run] id cd0624a8-793a-44ce-9af6-b8cf75a5cbee
hello from wf
[workflow] started HelloWorkflow input={"message":"hello from wf"}
[step] started PrintMessage#1 attempt=1
[step] completed PrintMessage#1 attempt=1 result=undefined
[workflow] completed HelloWorkflow result=undefined
Workflow completed.
```

Every orchestration call streams as an event while the run progresses.

### 4. Inspect it

Events are persisted, not just printed:

```bash
wf runs
wf history cd0624a8-793a-44ce-9af6-b8cf75a5cbee
```

For the same data as a graph in the browser, install the per-user dashboard
service and open it:

```bash
wf install
wf web
```

The service (`systemd --user` on Linux, `launchd` on macOS) serves workflow
graphs, run history, and connected integrations from `~/.wf` at
`http://127.0.0.1:4787`. It does not execute workflows. Windows service
registration is not implemented yet.

## Calling an external system

A workflow never carries credentials, and it never carries a connection. It
names an **alias** — a requirement, like an environment variable — and the
gateway binds that alias to a real connection per machine:

```ts
const createIssue = integration({
  source: { kind: "gateway", alias: "issues", tool: "create_issue" },
  input: t.struct({ team: t.string, title: t.string }),
  output: t.struct({ id: t.string, url: t.string })
})
```

> A workflow may only name things whose meaning is identical on every machine
> that runs it.

That single rule decides everything else: the alias and tool name travel with
the definition; connection names, owner tiers, credentials, and resolved tool
addresses stay behind the gateway. `wf validate` is the diff between what a
definition requires and what this machine supplies, and it exits non-zero while
anything is unbound — so it works as a gate before `wf run`.

Bootstrapping a workflow somebody else wrote is therefore a matter of creating
grants, not editing their source:

```bash
wf validate their-workflow            # which aliases are unbound
integrations discover <url>           # register the integration
integrations connect <slug>           # authorize it
integrations grant <client-id> <alias> <tool> --integration <slug>
wf validate their-workflow            # exits 0 — now runnable
```

## Where state lives

| Path | Contents |
| --- | --- |
| `~/.wf/workflows/<id>.ts` | The workflow catalog. One editable file per workflow, and the only authority for its source |
| `~/.wf/sources/<sha256>.ts` | The source each run started against, written at start and never modified |
| `~/.wf/engine.sqlite` | Durable engine state: step results, timers, suspended signal waits |
| `~/.wf/executor.sqlite` | Integration, connection, and tool metadata |
| `~/.wf/gateway.sqlite` | Clients, API keys, grants, frozen approvals, and the audit trail |
| `~/.wf/gateway.json` | Where the local gateway listens, and a key for it. Mode `0600` — this file is a credential |
| `~/.wf/executor-auth.json` | AES-GCM-encrypted credentials. Only the gateway process reads it |
| `~/.wf/executor-auth.key` | The user-only encryption key, mode `0600` |

Because a run pins the source snapshot it started against, you can edit a
workflow while one of its runs is parked on a signal.

## Where to go next

- [**wf CLI**](cli.md) — every command, flag, and output mode.
- [**TypeScript SDK**](wfkit.md) — `defineStep`, `defineWorkflow`, the `ctx`
  orchestration calls, the embeddable runtime, and the test runtime.
- [**Integrations CLI**](integrations.md) — discovery, connections, grants,
  approvals, drift, and codegen.
- [**Gateway client**](client.md) — calling granted tools from your own
  TypeScript.
- [**Effect services and layers**](effect-services-and-layers.md) — every Effect
  capability, its layer, dependencies, consumers, and lifecycle.
- [**System and call stacks**](system-architecture.md) — how the CLIs, gateway,
  executor, workflow runtime, storage, and external systems fit together.
