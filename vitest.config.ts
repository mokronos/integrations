import path from "node:path"
import { defineConfig } from "vitest/config"

const source = (relative: string): string => path.join(import.meta.dirname, relative)

/**
 * Workspace packages publish their built `dist`, so the `development`
 * condition is what points an importer at the TypeScript sources the tests are
 * written against. Vite resolves bare specifiers through node_modules, which
 * bun populates per package rather than at the root, so the aliases restate
 * what tsconfig's `paths` already declare.
 */
export default defineConfig({
  resolve: {
    conditions: ["development"],
    alias: {
      "@integrations/observability": source("packages/observability/src/index.ts"),
      "@integrations/contracts/gateway-config": source("packages/contracts/src/gateway-config.ts"),
      "@integrations/contracts/test-fixtures": source("packages/contracts/test/fixtures.ts"),
      "@integrations/contracts": source("packages/contracts/src/index.ts"),
      "@integrations/integrations": source("packages/integrations/src/index.ts"),
      "@integrations/gateway-core/domain": source("packages/core/gateway/src/domain.ts"),
      "@integrations/gateway-core/test-fixtures": source("packages/core/gateway/test/fixtures.ts"),
      "@integrations/gateway-core": source("packages/core/gateway/src/index.ts"),
      "@integrations/gateway-api/definition": source("packages/core/api/src/http/api.ts"),
      "@integrations/gateway-api": source("packages/core/api/src/index.ts"),
      "@mokronos/integrations-client/client": source("apps/ts/src/client.ts"),
      "@mokronos/integrations-client": source("apps/ts/src/index.ts"),
      "@mokronos/integrations": source("apps/local/index.ts")
    }
  },
  test: {
    include: ["{apps,packages}/**/test/**/*.test.ts"],
    exclude: ["**/node_modules/**", ".reference/**"],
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
})
