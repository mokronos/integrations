---
name: test-integrations-app
description: Run an isolated gateway, dashboard, and fixture MCP server from this checkout, then drive or screenshot the dashboard, exercise the CLIs and MCP end to end, and read the traces. Use when verifying a change in the real app, capturing dashboard screenshots, or reproducing a gateway bug.
---

# Test the integrations app

Everything runs in a **sandbox**: a throwaway `INTEGRATIONS_HOME` under `/tmp` with its own gateway, dashboard dev server, and fixture MCP server on free ports. `~/.integrations` is the developer's live gateway; the sandbox never reads or writes it.

## 1. Bring the sandbox up

```sh
bun run scripts/test-env.ts up
```

It prints the sandbox as JSON: `home`, `gateway.url`, `dashboard.url`, `fixture.url`, and `traces` (the directory holding the trace files). Keep that JSON; every later step uses its values. Reuse a live sandbox across turns: `status --home <home>` tells you whether it is still up, and `up --home <home>` restarts it on the same ports with its data intact.

A new sandbox comes seeded. The fixture MCP server (`scripts/fixture-mcp.ts`, one `echo` tool) is registered and connected as alias `org___fixture___default`, and `echo` is granted and allowed for the local clients. `--no-seed` gives an empty gateway.

Done when `status` reports `gatewayUp`, `dashboardUp`, and `fixtureUp` true.

## 2. Exercise the change

Run the CLIs from this checkout: `apps/cli/src/agent.ts` is `i` and `apps/cli/src/main.ts` is `ii`. Prefix every call with `INTEGRATIONS_HOME=<home>`; that is what points them at the sandbox. The installed `i` and `ii` on PATH are the live install.

```sh
INTEGRATIONS_HOME=<home> bun run apps/cli/src/agent.ts execute org___fixture___default echo '{"text":"hi"}'
INTEGRATIONS_HOME=<home> bun run apps/cli/src/main.ts clients            # --help lists every command
```

`<home>/gateway.json` holds the agent key for calling `<gateway.url>/mcp` directly.

The dashboard at `dashboard.url` is a Vite dev server. It proxies `/v1` to the sandbox gateway, reloads on source edits across `apps/web` and `packages/*`, and signs in automatically with the gateway's loopback credential.

Done when the behavior the change is about has happened in the sandbox, not just in unit tests.

## 3. Capture evidence

**Interactive** (clicks, forms, dialogs): use the T3 Code preview tools.

1. Call `preview_open` with `dashboard.url`, then `preview_navigate`, `preview_click`, `preview_type`, `preview_wait_for`.
2. Call `preview_snapshot` with `save: true` and embed the returned `screenshotPath` in the reply as `![what it shows](path)`.
3. If the tools answer "No preview automation host is available", ask the developer to open the preview panel in T3 Code. Meanwhile, capture static routes.

**Static** (how a route renders):

```sh
bun run scripts/test-env.ts screenshot --home <home> /integrations [--width 390 --height 844]
```

It prints the PNG path under `<home>/shots/`. The default size is 1280×800, and the routes are in `apps/web/src/App.tsx`. Read the image to check the result yourself, then embed it in the reply.

Done when every UI claim in your reply has a screenshot beside it, and you have looked at each one.

## 4. Read the traces

Every span the sandbox gateway and CLIs finish is in `<traces>/gateway.trace.ndjson` and `<traces>/cli.trace.ndjson`, and each CLI command is one trace across both.

1. Get the trace id. A 500 prints `(trace <id>)`. For anything else, take the last failed command:

   ```sh
   jq -r 'select(.name == "Cli.command" and .outcome == "failure") | .traceId' <traces>/cli.trace.ndjson | tail -1
   ```

2. Read everything that trace did:

   ```sh
   jq -c --arg t <id> 'select(.traceId == $t) | {service, name, outcome, attributes, cause}' <traces>/*.trace.ndjson
   ```

A refusal is not a fault. For a 4xx, every gateway span succeeds, and the answer is in the attributes: `http.response.status_code` on `http.server …`, `invocation.outcome` on `Invocation.settle`, and the "Request refused" event with its `error.tag`. `outcome: "failure"` means something actually threw, and `cause` says where.

More queries and the record shape are in `packages/observability/README.md`. The processes' console output is in `<home>/gateway.log`, `<home>/dashboard.log`, and `<home>/fixture.log`.

## 5. Tear down when the loop is over

The loop is over when the developer says so or the task is complete with nothing left for them to review. Until then, leave the sandbox running and give them `dashboard.url`.

```sh
bun run scripts/test-env.ts down --home <home> --remove
```

`--remove` deletes the home, including `shots/` and the traces. Drop it while a reply still links to screenshots in there.

`down` stops only the PIDs recorded in `<home>/test-env.json`, and only while they still run from this checkout. Stop a sandbox this way, never by matching process names.

## Gotchas

- **Gateway code is loaded once.** A gateway keeps the modules it started with, so after editing gateway or package code, run `up --home <home>` to restart it. Dashboard code hot-reloads.
- **Gateway-served dashboard.** `<gateway.url>/` serves `apps/web/dist`, which only `bun run build:control-plane` refreshes. Test the UI at `dashboard.url`.
- **Grant tools in pairs.** A tool added to an access profile needs a decision in the approval policy too (`ii approval-policy-tool …`). Without one, every tool listing for that client fails with a 500. Leaving the decision out on purpose is also the quickest reproducible 500.
