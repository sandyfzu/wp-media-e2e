import "./src/common/config/load-env";

import { createProductConfig } from "./src/common/config/project";
import { backwpup } from "./src/projects/backwpup/config/backwpup.config";

// BackWPup entry. Run a single cell pinned, so bddgen regenerates only its specs:
// `E2E_CELL=<cell> npm run test:backwpup`.
export default createProductConfig(backwpup);
