import { isAbsolute } from "node:path";

import type { ReporterDescription } from "@playwright/test";
import { cucumberReporter } from "playwright-bdd";

import { env } from "./env";

/**
 * The layered reporter stack for one run unit, written into `reportDir`:
 *
 *  - `list`              — concise terminal output.
 *  - Playwright `html`   — the interactive runner report (trace viewer, video).
 *  - Cucumber `html`     — the Gherkin-centric report, dual-mode via REPORT_MODE:
 *      • default       → `externalAttachments: false` — one portable, self-contained
 *                        file with screenshots/video embedded on failure (the heavy
 *                        trace zip is dropped; the trace stays viewable in the
 *                        Playwright HTML report).
 *      • REPORT_MODE=rich → `externalAttachments: true` — a separate `data/` folder
 *                        with the embedded interactive trace viewer (serve over http).
 *  - `allure-playwright` — raw Allure results under `<reportDir>/allure-results`. The
 *                        analytics report (history/trends, flaky categories, dashboard)
 *                        is generated from them by `scripts/allure.mjs` (`npm run
 *                        report:allure`); report config lives in `allurerc.mjs`.
 *
 * @param reportDir - the run's report folder, absolute. Playwright resolves its reporters'
 *   relative paths against the config's folder, but allure-playwright resolves `resultsDir`
 *   against the working directory, so a relative folder splits the report when a run starts
 *   anywhere but the repository root.
 * @throws {@link Error} when `reportDir` is relative.
 */
export function reporters(reportDir: string): ReporterDescription[] {
  if (!isAbsolute(reportDir)) {
    throw new Error(
      `[reporting] The report folder must be absolute, got "${reportDir}": a relative one ` +
        "would send Allure's results to wherever the run was started.",
    );
  }
  const rich = env("REPORT_MODE") === "rich";
  return [
    ["list"],
    ["html", { outputFolder: `${reportDir}/playwright`, open: "never" }],
    cucumberReporter("html", {
      outputFile: `${reportDir}/cucumber/index.html`,
      externalAttachments: rich,
      skipAttachments: rich ? false : ["application/zip"],
    }),
    ["allure-playwright", { resultsDir: `${reportDir}/allure-results` }],
  ];
}
