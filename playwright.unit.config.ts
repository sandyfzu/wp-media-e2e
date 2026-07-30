import { defineConfig } from "@playwright/test";

/**
 * Unit / integration tests for everything under `src/` — the shared `common/` layer (WP
 * automation, config, artifacts, page objects) **and** each product's own specs, so a product
 * page object's locator contract is covered by the same command. These run with NO external
 * environment: the WP-CLI layer is exercised through a stub `wp` on PATH, and page objects
 * against `setContent` fixtures. Run: `npm run test:unit`.
 *
 * Kept separate from the product BDD configs (`playwright.<product>.config.ts`), which run only
 * generated feature specs out of their bddgen output dirs (`.features-gen/`, outside `src/`) and
 * never match these `*.spec.ts` files.
 */
export default defineConfig({
  testDir: "src",
  testMatch: /\.spec\.ts$/,
  reporter: [["list"]],
});
