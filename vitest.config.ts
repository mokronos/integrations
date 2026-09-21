import { defineConfig } from "vitest/config"

/**
 * Workspace packages publish their built `dist`, so the `development`
 * condition is what points an importer at the TypeScript sources the tests are
 * written against. Every manifest lists it ahead of `types` and `default`.
 */
export default defineConfig({
  resolve: {
    conditions: ["development"]
  },
  test: {
    include: ["{apps,packages}/**/test/**/*.test.ts", "scripts/**/*.test.ts"],
    exclude: ["**/node_modules/**", ".reference/**"],
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
})
