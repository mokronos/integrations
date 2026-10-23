# AGENTS.md

When im using these words im talking about the following:

- "you": i mean you, the coding agent helping me implement and design this system
- "agent": i'm talking about the agent that is using this library/system to create workflows, etc.
- "user": i'm talking about the user of the agent

## Development

This project is in an early stage of development.

- Don't create db migrations, if they aren't auto-generated
  - Each package declares its tables once, in Drizzle: the gateway in
    `packages/gateway-core/src/db/schema.ts`, the integrations package in
    `packages/integrations/src/db/schema.ts`. Change it there and run
    `bun run db:generate` in that package, which writes the SQL and embeds it
    for the runtime. Never hand-edit `db/migrations/*.sql` or a `*.gen.ts`.
- Don't create any shims or backwards compatibility code

## Migrations

Migrations must keep the app online. A gateway applies them when it starts, while an older gateway may still be serving the same data (a rolling Cloudflare deploy, a service restart).

- **Expand, deploy, contract.** Add the new table or column first, ship the code that uses it, and drop the old one in a later release once no running code reads it. Never drop or rename a required column before its replacement is deployed.
- **Applied migrations are immutable.** Change the Drizzle schema and generate a new migration; the migrator refuses a renamed or rewritten one.
- **Migrations run on real data.** Each one must succeed on tables that hold rows and keep those rows; `packages/gateway-core/test/migrate.test.ts` seeds every table before the newest migration and checks the rows survive.

## Type Discipline

- Never use `any` or `unknown`. Model every compile-time-known shape with Effect Schema (the schema is the single source of truth; derive TS types via `typeof X.Type`), brand identifiers where mix-ups are possible, and parse external/dynamic data at the boundary with `Schema.decodeUnknown*` instead of casting. No `as` casts to silence the compiler.

## Errors

- **One typed error per failure a caller can act on.** Callers receive the
  classes in `packages/contracts/src/errors.ts`; each carries its HTTP status,
  structured fields, and `message`/`hint`/`retryable` getters built from those
  fields only. Never copy `cause.message` into a field; bounded upstream text
  goes in a named field such as `detail`.
- **Translate once, at the boundary.** Domain errors map to contract errors in
  `toGatewayError` (gateway-core). Storage failures go through `capture` and
  leave as a `GatewayFailure` trace id, never as text.
- **Surfaces only render.** HTTP encodes the error, MCP uses `describeError`
  plus `structuredContent`, the CLI uses `reportFailure` (stderr, exit code by
  category), the dashboard uses `ErrorNotice`/`toastError`. Don't add
  surface-specific wording for a failure; fix its class instead.

## Two ways to hurt yourself

1. **Killing by pattern.** Your own shell's argv contains the same paths and ports as the process you mean, so `pkill -f` / `pgrep | kill` can kill you or another gateway on this machine. Stop only a PID you recorded at spawn, or the listener of your port (`ss -ltnpH 'sport = :<port>'`) after checking `/proc/<pid>/cwd` is this checkout.
2. **Testing on the live gateway.** `~/.integrations` is the developer's real gateway, database, and keys, in use while you work. Test in a sandbox (`test-integrations-app`). The live install is touched only by the After Task Routine.

## Verifying

- **Smallest proof first.** Run `bun --bun run vitest run <test files>` for the tests covering your change, then `bun run format` and `bun run check` (format check, lint, typecheck, test boundary). Run the full `bun run test` before committing a change that crosses packages.
- **Red before green.** A bug fix starts with a test that goes red on the unfixed code; record the failing assertion. A setup error or an unrelated timeout is not red. Check the reported test count, so a filtered-out test is not mistaken for green. Wait on a condition, not a fixed sleep.
- **Test behavior.** A test earns its place by catching a regression in logic or wire behavior; one that restates the implementation does not.
- **Run it for real.** Changes to the dashboard, the gateway's HTTP/MCP behavior, or CLI output get one pass in a sandbox with the `test-integrations-app` skill. UI claims in your reply come with screenshots.
- **Debug from traces.** When something fails, read the trace before adding logging: every process appends its spans to `$INTEGRATIONS_HOME/logs/*.trace.ndjson`, and a failed request prints `(trace <id>)`. Queries are in `packages/observability/README.md`.

## After Task Routine

- refresh the local install of cli + gateway + dashboard, etc. when you finish a task or commit something

## Effect

Don't be afraid to use unstable modules from effect.

<!-- effect-solutions:start -->

## Effect Best Practices

**IMPORTANT:** Always consult effect-solutions before writing Effect code.

1. Run `effect-solutions list` to see available guides
2. Run `effect-solutions show <topic>...` for relevant patterns (supports multiple topics)
3. Search `~/.local/share/effect-solutions/effect` for real implementations

Topics: quick-start, project-setup, tsconfig, basics, services-and-layers, data-modeling, error-handling, config, testing, cli.

Never guess at Effect patterns - check the guide first.

## Local Effect Source

The Effect v4 repository is cloned to `~/.local/share/effect-solutions/effect` for reference.
Use this to explore APIs, find usage examples, and understand implementation
details when the documentation isn't enough.
<!-- effect-solutions:end -->
