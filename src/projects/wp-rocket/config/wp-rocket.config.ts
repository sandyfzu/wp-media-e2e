import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { loadSites } from "../../../common/config/sites";
import type {
  ProductArtifacts,
  ProductConfig,
} from "../../../common/config/types";

const configDir = dirname(fileURLToPath(import.meta.url));

/**
 * WP Rocket's artifact manifest (plan §2.3). WP Rocket is a single-output, editionless
 * plugin whose version is embedded in `wp-rocket.php`, so it declares no variants and no
 * default version — an `E2E_PLUGIN_VERSION`/`E2E_PREVIOUS_VERSION` override, if given, is
 * still passed through and APVM rewrites the source version. The `previous` role is
 * supported from day one (update-path tests) and defaults to the latest stable tag; the
 * identity block is verified from `wp-media/wp-rocket` `wp-rocket.php` (plan §1.2).
 */
const artifacts: ProductArtifacts = {
  project: "wp-rocket",
  defaultRef: { plugin: "develop", previous: "tag:latest-stable" },
  version: { kind: "embedded" },
  edition: {
    kind: "editionless",
    identity: {
      slug: "wp-rocket",
      mainFile: "wp-rocket.php",
      pluginName: "WP Rocket",
    },
  },
};

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
  artifacts,
};
