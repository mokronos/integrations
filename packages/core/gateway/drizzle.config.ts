import { defineConfig } from "drizzle-kit"

/** `bun run db:generate` diffs `db/schema.ts` against the snapshots in
 *  `db/migrations/meta` and writes the SQL that closes the gap.
 *
 *  There are no `dbCredentials` on purpose: generating is the only thing this
 *  config is used for. Applying is the runtime's job (`src/migrate.ts`), which
 *  reads the embedded copy of these files so a D1 binding — with no filesystem
 *  to read migrations from — runs exactly what a local file runs. */
export default defineConfig({
  dialect: "sqlite",
  schema: "./db/schema.ts",
  out: "./db/migrations"
})
