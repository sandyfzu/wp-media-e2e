import "./src/common/config/load-env";

import { createProductConfig } from "./src/common/config/project";
import { backwpup } from "./src/projects/backwpup/config/backwpup.config";

// BackWPup entry. Run a single cell: `playwright test --config playwright.backwpup.config.ts --project=<cell>`.
export default createProductConfig(backwpup);
