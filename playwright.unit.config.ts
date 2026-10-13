import { defineConfig } from "@playwright/test";

import { env } from "./src/common/config/env";

/**
 * Unit / integration tests for everything under `src/` — the shared `common/` layer (WP
 * automation, config, artifacts, page objects) **and** each product's own specs, so a product
 * page object's locator contract is covered by the same command — and for the orchestrator under
 * `orchestrator/`. These run with NO external environment: the WP-CLI layer is exercised through a
 * stub `wp` on PATH, and page objects against `setContent` fixtures. Run: `npm run test:unit`.
 *
 * Kept separate from the product BDD configs (`playwright.<product>.config.ts`), which run only
 * generated feature specs out of their bddgen output dirs (`.features-gen/`, outside `src/`) and
 * never match these `*.spec.ts` files.
 */
export default defineConfig({
  testMatch: /\.spec\.ts$/,
  // One project per source tree, each rooted in its own folder, so a spec runs only from where specs
  // belong. A `testDir` at the repository would turn off Playwright's `.gitignore` filtering (it
  // applies only when no `testDir` is set) and run every checkout's specs under `.claude/worktrees/`.
  // UI mode ticks only the first project until a choice is saved: tick `orchestrator` there once.
  projects: [
    { name: "src", testDir: "src" },
    { name: "orchestrator", testDir: "orchestrator" },
  ],
  // A folder of its own, because Playwright empties its output folder as a run starts: under
  // `OUTPUT_ROOT` like every run's, and `_`-prefixed so no product (a folder name) can own it.
  // Read with `env()` alone: `.env` and `run-context.ts` stay out of unit runs.
  outputDir: `${env("OUTPUT_ROOT", "test-results")}/_unit`,
  reporter: [["list"]],
});
