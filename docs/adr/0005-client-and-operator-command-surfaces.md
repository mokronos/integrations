# Client and operator command surfaces are separate

The command-line product exposes `i` as the remote client surface and `ii` as
its strict operator superset. Both compose shared command definitions from one
package: `i` can discover integrations, provision connections, inspect its
grants, invoke tools, and poll its own approvals; `ii` adds every control-plane
action and the local gateway lifecycle. An environment variable does not hide
commands because a sandbox can change its environment, and a separate
implementation would let the two clients drift.

## Consequences

- Client API keys use named provisioning or administration capabilities while
  grants remain the only source of tool authority.
- Approval decisions require a human session or the trusted loopback control
  plane; no API key can approve its own invocation.
- `ii` stores a revocable human session for dashboard-equivalent commands and
  relies on operating-system authority, not gateway authentication, for
  `serve`, `install`, `uninstall`, and upgrades.
- The public TypeScript client matches `i` and exposes no generic request escape
  hatch into control-plane routes.
