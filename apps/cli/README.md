# @integrations/integrations

One package installs two deliberate command surfaces:

- `i` is the agent/client CLI. It mirrors the public TypeScript client and can
  discover integrations, manage connections, inspect schemas, invoke effective policy
  tools, and poll its own approvals.
- `ii` is the human/operator CLI. It is a strict superset of `i`, adds every
  gateway dashboard action, human login and account management, and local
  gateway lifecycle commands.

```bash
bun add --global @integrations/integrations
ii login
```

Run `i --help` or `ii --help` for the full command surface.
