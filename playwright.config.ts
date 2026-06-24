import "./src/common/config/load-env";

import { createProductConfig } from "./src/common/config/project";
import { backwpup } from "./src/projects/backwpup/config/backwpup.config";
import { wpRocket } from "./src/projects/wp-rocket/config/wp-rocket.config";

/**
 * Default config for a bare `playwright test` and IDE discovery. Real runs target
 * a product config (`playwright.<product>.config.ts`) via the npm scripts or the
 * orchestrator. Choose the default product with `PRODUCT=backwpup`.
 *
 * Select a cell with `--project=<cell>` to use that cell's full site pool; without
 * one, the run is serial (workers = 1) and safe.
 */
const product = process.env.PRODUCT === "backwpup" ? backwpup : wpRocket;

export default createProductConfig(product);
