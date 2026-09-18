# @mokronos/integrations-cli

One package installs two deliberate command surfaces:

- `i` is the agent/client CLI. It mirrors the public TypeScript client and can
  discover integrations, manage connections, inspect schemas, invoke effective policy
  tools, and poll its own approvals.
- `ii` is the human/operator CLI. It is a strict superset of `i`, adds every
  gateway dashboard action, human login and account management, and local
  gateway lifecycle commands.

Install from GitHub with curl, Git, and Bun 1.2 or newer:

```bash
curl -fsSL https://raw.githubusercontent.com/mokronos/integrations/main/install.sh | sh
ii install
ii dashboard
```

Use `ii serve -d` instead of `ii install` to run the gateway without registering
a per-user service. Re-run the installer to upgrade.

Contributors can clone the repository and run `bun install && bun run
install:local`; those shims run the checkout's TypeScript sources directly.

Run `i --help` or `ii --help` for the full command surface.
