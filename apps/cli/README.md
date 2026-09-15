# @mokronos/integrations-cli

One package installs two deliberate command surfaces:

- `i` is the agent/client CLI. It mirrors the public TypeScript client and can
  discover integrations, manage connections, inspect schemas, invoke effective policy
  tools, and poll its own approvals.
- `ii` is the human/operator CLI. It is a strict superset of `i`, adds every
  gateway dashboard action, human login and account management, and local
  gateway lifecycle commands.

The packages are not on npm yet. Install from the repository with Bun 1.2 or
newer:

```bash
git clone https://github.com/mokronos/integrations.git
cd integrations
bun install
bun run install:local
ii login
```

`install:local` puts `i` and `ii` on PATH as shims that run the TypeScript
sources in the checkout, so `git pull && bun install` is the whole upgrade.

Run `i --help` or `ii --help` for the full command surface.
