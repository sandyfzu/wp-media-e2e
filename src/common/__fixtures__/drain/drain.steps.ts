import { writeFileSync } from "node:fs";

import { Given } from "../../fixtures";
import { STOP_FILE_ENV } from "../../config/drain";

/**
 * Steps for the drain's end-to-end spec (`config/drain.run.spec.ts`). They touch nothing but the
 * run's own stop file, so the scenarios need no real site.
 */

Given(
  "the run is asked to stop during the first attempt, which then fails",
  ({ $testInfo }) => {
    if ($testInfo.retry > 0) return;
    const stopFile = process.env[STOP_FILE_ENV];
    if (stopFile === undefined) throw new Error(`${STOP_FILE_ENV} is not set`);
    writeFileSync(stopFile, "");
    throw new Error(
      "the first attempt fails on purpose, after asking the run to stop",
    );
  },
);

Given("nothing else happens", () => {
  // The scenario's outcome is decided before it gets here.
});
