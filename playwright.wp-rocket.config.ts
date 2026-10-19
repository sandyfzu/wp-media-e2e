import "./src/common/config/load-env";

import { createProductConfig } from "./src/common/config/project";
import { wpRocket } from "./src/projects/wp-rocket/config/wp-rocket.config";

// WP Rocket entry. Run a single cell pinned, so bddgen regenerates only its specs:
// `E2E_CELL=<cell> npm run test:wp-rocket`.
export default createProductConfig(wpRocket);
