# platform-demo

The smallest application that embeds the gateway rather than talking to it.

- **One database.** `drizzle.config.ts` lists the platform's own schema next to
  the gateway's and the integration host's, so `bun run db:generate` writes one
  migration set under `drizzle/`. The app applies it with drizzle's migrator at
  start and opens the gateway core on the same connection with `migrate: false`.
- **One process.** `gatewayCoreLayer` provides the store, the integration host
  and OAuth sessions as Effect services. The page calls `listEffectiveTools`
  for schemas and `invokeAsClient` for execution; no HTTP hop, no API key.
- **One page.** Create an agent (a platform row holding a gateway client), add
  a no-auth OpenAPI integration, and run a tool under the gateway's policy.

```bash
bun run --cwd apps/platform-demo dev
```

Then open http://127.0.0.1:4100. State lives under `apps/platform-demo/data/`.
