import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { loadSites } from "../../../common/config/sites";
import type { ProductConfig } from "../../../common/config/types";

const configDir = dirname(fileURLToPath(import.meta.url));

/**
 * WP Rocket product configuration. Globs are repo-root-relative (the Playwright
 * config entry that consumes this lives at the repo root). WP Rocket has no
 * external-service configuration.
 */
export const wpRocket: ProductConfig = {
  name: "wp-rocket",
  features: "src/projects/wp-rocket/features/**/*.feature",
  steps: [
    "src/common/fixtures.ts",
    "src/common/steps/**/*.ts",
    "src/projects/wp-rocket/steps/**/*.ts",
  ],
  sites: loadSites(configDir),
};
