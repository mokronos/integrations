# @integragents/host-cloudflare

Experimental. The local and self-hosted gateways in the root README are the
supported paths.

The gateway on Cloudflare, provisioned with [Alchemy](https://alchemy.run):

- One Worker serves the dashboard as static assets and forwards the gateway's
  routes (`gatewayRoutes`) to the gateway.
- The gateway runs in a single SQLite-backed Durable Object. Its storage is the
  gateway's database, with the same schema, migrations, and transactions as the
  local SQLite file.
- Blobs are rows in that same SQLite storage (`BlobStore.sqlLayer`), chunked
  under the 2 MB value limit. `src/r2-blobs.ts` is the R2 alternative, ready
  for when R2 is enabled on the account: swap `blobs` in `src/gateway.ts`.
- A cron trigger runs maintenance every five minutes.
- The master key is generated once per stage and kept in that stage's Alchemy
  state. Destroying the stage destroys the key and everything it sealed.

## Stages

| Command | Stage |
| --- | --- |
| `bun run dev` | `dev_$USER`, entirely local (workerd), state in `.alchemy/` |
| `bun run deploy -- --stage staging` | `integrations-gateway-staging.<subdomain>.workers.dev` |
| `bun run deploy -- --stage prod` | `integrations-gateway.<subdomain>.workers.dev` |
| `bun run destroy -- --stage <stage>` | removes the stage and its data |

Deployed stages keep their state in the account (`Cloudflare.state()`), so any
machine or CI job sees the same records.

Deploying needs `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`. Local
development never calls Cloudflare but still needs an account id to plan; any
32-character hex string works.

Optional settings are bound when present in the deploying environment:
`INTEGRATIONS_GOOGLE_CLIENT_ID` and `INTEGRATIONS_GOOGLE_CLIENT_SECRET` for
Google sign-in, and `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`,
`OTEL_TRACES_EXPORTER`, `OTEL_LOGS_EXPORTER` for OTLP export.

## Tests

`test/worker.test.ts` deploys the stack locally and drives it over HTTP. It is
part of `bun run test` and needs no Cloudflare account.

Local dev does not deliver cron events to a Worker that serves assets, so the
schedule only runs once deployed.
