import "./src/common/config/load-env";

import { createProductConfig } from "./src/common/config/project";
import { productFromEnv } from "./src/projects/products";

/**
 * Default config for a bare `playwright test` and IDE discovery. Real runs target
 * a product config (`playwright.<product>.config.ts`) via the npm scripts or the
 * orchestrator. Choose its product with `PRODUCT=backwpup` (unset: WP Rocket); a name no
 * product has fails here.
 *
 * Pin a cell with `E2E_CELL=<cell>` (or select it with `--project=<cell>`) to use that cell's
 * full site pool; a run of no single cell is serial (workers = 1) and safe.
 */
export default createProductConfig(productFromEnv(process.env.PRODUCT));
