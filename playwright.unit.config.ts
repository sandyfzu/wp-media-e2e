import { defineConfig } from "@playwright/test";

/**
 * Unit / integration tests for the shared `src/common` layer (the WP automation modules and
 * page objects). These run with NO external environment: the WP-CLI layer is exercised through
 * a stub `wp` on PATH, and the page objects against `setContent` fixtures. Run: `npm run test:unit`.
 *
 * Kept separate from the product BDD configs (`playwright.<product>.config.ts`), which run only
 * generated feature specs out of their bddgen output dirs and never match these `*.spec.ts` files.
 */
export default defineConfig({
  testDir: "src/common",
  testMatch: /\.spec\.ts$/,
  reporter: [["list"]],
});
