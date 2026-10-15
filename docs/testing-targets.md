# Black-box test targets

Black-box tests reach the product only through its CLIs, HTTP, MCP, and
`@integragents/client`; `bun run check:test-boundary` enforces that.

| Scenario                                                                                                               | Local (Bun)    | Docker        | Cloudflare                           |
| ---------------------------------------------------------------------------------------------------------------------- | -------------- | ------------- | ------------------------------------ |
| `apps/cli/test/acceptance.test.ts`: CLI sessions and keys, discover/connect/invoke, profile authority, listing windows | `bun run test` | —             | —                                    |
| `apps/cli/test/remote.acceptance.ts`: sign up, create a profile and key, call through the client                       | manual         | manual        | manual                               |
| `apps/host-cloudflare/test/worker.test.ts`: blob upload/download, OAuth metadata routing                               | —              | —             | `bun run test` (local Alchemy stack) |
| Image health: `integrations health` exits 0                                                                            | —              | CI (`ci.yml`) | —                                    |

"manual" means `INTEGRATIONS_STAGING_URL=https://… bun run --cwd apps/cli test:remote`
against a deployed gateway on that target.
