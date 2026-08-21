# wf

`wf` is an agent-first platform for authoring and running durable TypeScript
workflows. Agents design readable workflow artifacts; the runtime persists step
results, timers, and signal waits in SQLite so runs can survive restarts and
replay deterministically.

The documentation site is the canonical user reference:

- [Overview and quickstart](https://mokronos.github.io/wf/docs/)
- [wf CLI](https://mokronos.github.io/wf/docs/cli/)
- [TypeScript SDK](https://mokronos.github.io/wf/docs/wfkit/)
- [Integrations CLI](https://mokronos.github.io/wf/docs/integrations/)
- [Gateway client](https://mokronos.github.io/wf/docs/client/)

## Install

```bash
bun install -g @mokronos/wf
wf create hello
wf validate hello
wf run hello '{"message":"hello from wf"}'
```

`npm install -g`, `pnpm add -g`, and `yarn global add` also work. The `wf`
binary runs without Bun after installation. State defaults to `~/.wf`; set
`WF_HOME` to use another directory.

## Core ideas

- **Structured orchestration:** typed steps, retries, timers, signals, parallel
  work, and compensations are durable runtime primitives.
- **Typed integrations:** a workflow declares a gateway alias and tool name.
  A grant binds that requirement to a local connection, so credentials and
  connection names never enter workflow source.
- **Code for computation:** small deterministic transforms stay as TypeScript
  code nodes; external IO belongs in durable steps.

## Repository map

| Path | Purpose |
| --- | --- |
| `apps/docs/docs/` | Canonical product and API documentation |
| `packages/wf/` | `@mokronos/wfkit` SDK and agent authoring guidance |
| `apps/cli/` | `@mokronos/wf` CLI and workflow dashboard service |
| `apps/integrations/` | Gateway, integrations CLI, browser UI, and TypeScript client |
| `examples/` | Runnable workflow examples |
| `docs/adr/` | Accepted architecture decisions |
| `docs/plans/` | Completed or in-progress implementation records |

`CONTEXT.md` defines the integration-domain vocabulary. `VISION.md` records
product direction. Historical design notes in `docs/` are not current API
reference material.

## Development

```bash
bun run typecheck
bun test
bun run verify
```
