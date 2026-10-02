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
    exclude: [
      "**/node_modules/**",
      ".reference/**",
      // Alchemy 2.0.0-beta.79 still imports `effect/unstable/*`, which Effect 4.0.0 removed.
      // Run the Cloudflare host again once an Alchemy release targets Effect 4.0.0.
      "apps/host-cloudflare/**"
    ],
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
})
