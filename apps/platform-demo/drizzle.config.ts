import { defineConfig } from "drizzle-kit"

// The platform owns the database, so its migration pipeline sees every table:
// its own, the gateway's, and the integration host's.
export default defineConfig({
  dialect: "sqlite",
  schema: [
    "./src/db/schema.ts",
    "../../packages/core/gateway/src/db/schema.ts",
    "../../packages/integrations/src/db/schema.ts"
  ],
  out: "./drizzle"
})
