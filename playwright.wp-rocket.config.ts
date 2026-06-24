import "./src/common/config/load-env";

import { createProductConfig } from "./src/common/config/project";
import { wpRocket } from "./src/projects/wp-rocket/config/wp-rocket.config";

// WP Rocket entry. Run a single cell: `playwright test --config playwright.wp-rocket.config.ts --project=<cell>`.
export default createProductConfig(wpRocket);
