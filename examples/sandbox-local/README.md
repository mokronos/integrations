# Local Sandboxed Agent

This example runs the Pi agent harness on the host while every filesystem and
shell tool runs in a local [Gondolin](https://github.com/earendil-works/gondolin)
Linux micro-VM. The integrations gateway and its delegated API key stay on the
host.

```text
Pi on host -> Gondolin VM -> host credential broker -> integrations gateway
```

The VM receives a non-secret placeholder key. The broker replaces it with a
host-only delegated key and forwards only routes used by the `i` CLI. Gateway
grants remain the final authority for tool execution.

## Requirements

- Linux or macOS
- Node.js 23.6 or newer
- Bun 1.2 or newer
- QEMU 7.2 or newer
- A running integrations gateway

Install the repository dependencies once:

```bash
bun install
```

Gondolin downloads its guest assets on the first run.

Gondolin requires QEMU's `stream` network backend, introduced in QEMU 7.2.
Ubuntu 22.04's packaged QEMU 6.2 is not compatible; upgrade to Ubuntu 24.04
or install a newer QEMU and ensure its `qemu-system-*` binary appears first in
`PATH`. The extension checks this before starting the credential broker or VM.

## Create A Delegated Client

Create a client that may search, discover, and connect integrations. Do not give
it gateway administration capability.

```bash
ii client sandbox-local --provision
ii key <client-id>
ii grant <client-id> <alias> <tool> --integration <integration> --allow
```

Keep the key in the host shell. It is read by the trusted Pi extension and is
never copied into the VM:

```bash
export INTEGRATIONS_URL=http://127.0.0.1:4788
export INTEGRATIONS_API_KEY=<delegated-key>
```

## Run Pi

Start Pi from the project the agent should edit. Use absolute paths for the Pi
binary and extension:

```bash
cd /path/to/agent-project
/path/to/integrations/examples/sandbox-local/node_modules/.bin/pi \
  --no-extensions \
  --no-approve \
  -e /path/to/integrations/examples/sandbox-local/src/extension.ts
```

`--no-extensions` disables discovered host extensions but still loads the
explicit `-e` extension. `--no-approve` prevents project settings, packages, and
extensions from entering the host trust boundary. The extension also rejects
project trust as defense in depth.

The project is mounted read-write at `/workspace`. The integrations checkout
and host Bun installation are mounted read-only. No host environment is
inherited by tool processes; the VM receives only its guest paths, locale, the
broker URL, and the placeholder key.

## Use Integrations

The agent can use the normal CLI without special OAuth flags:

```bash
i search github
i discover <integration-url>
i connect <integration>
i tools <integration>
i schema <integration> <tool>
i execute <alias> <tool> '{}'
```

When `i connect` starts OAuth, the host broker observes the gateway's validated
OAuth response. Pi asks the human to confirm the integration, connection, and
authorization host. After confirmation, Pi opens the URL in the host browser.
The CLI continues polling in the VM until the gateway receives the OAuth
callback.

The guest contains a no-op `xdg-open`, so the CLI's own browser launch succeeds
without letting the agent launch host applications.

The TypeScript client is mounted read-only into the workspace's `node_modules`,
so normal imports work without modifying the host project. This included script
demonstrates it:

```bash
bun /opt/integrations/examples/sandbox-local/guest/client-demo.ts \
  <alias> <tool> '{"example":"value"}'
```

Code created in `/workspace` can import `@mokronos/integrations-client`
normally. The client, its contracts package, and Effect are separate read-only
mounts; other entries in the project's `node_modules` remain untouched.

## Boundary

The VM can:

- Read and modify the selected project.
- Search, discover, validate, connect, and disconnect integrations through `i`.
- Invoke only tools granted to its delegated gateway client.
- Read the status of its own pending approvals.

The VM cannot:

- Read the real gateway key or model-provider credentials.
- Read unrelated host files.
- Reach the gateway, host services, or Internet directly.
- Create clients or keys, change grants, approve calls, or use operator routes.
- Launch host applications.

The broker hides the credential; it does not remove its authority. Calls made
through the broker spend the delegated client's grants. Use a separate,
revocable client with narrow grants for every sandbox deployment.

The writable project mount is intentional host state. Gondolin isolates the
rest of the host and uses a VM boundary, but it does not prevent an agent from
damaging files inside that selected project.
