import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

import type { ReporterDescription } from "@playwright/test";
import { cucumberReporter } from "playwright-bdd";

import type { RunDescription } from "../reporting/run-description";
import { env } from "./env";

/**
 * One of the suite's own reporters, by its file, absolute: Playwright resolves a relative reporter
 * path against the config's folder, and the configs live at the repository root.
 *
 * @param file - the reporter's file name in `src/common/reporting/`.
 */
function ownReporter(file: string): string {
  return fileURLToPath(new URL(`../reporting/${file}`, import.meta.url));
}

/**
 * The layered reporter stack for one run unit, written into `run.reportPath`:
 *
 *  - cell notice         — one line naming the run's cell and how it was chosen; first, so it
 *                          prints before `list`'s "Running …" (`reporting/cell-notice.ts`).
 *  - results stream      — every attempt and the totals as JSON lines, in `results.jsonl`, as they
 *                          happen; silent. Before the reports, so its last line lands before
 *                          their slow `onEnd` (`reporting/results-stream.ts`).
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
 *  - run summary         — the verdict, what was tested and where the reports are; last, and
 *                          printed in `onExit`, so it is the run's final block (`reporting/run-summary.ts`).
 *
 * The suite's own reporters each receive `run` as their options.
 *
 * @param run - what the config factory knows about the run. Its `reportPath` must be absolute:
 *   Playwright resolves its reporters' relative paths against the config's folder, but
 *   allure-playwright resolves `resultsDir` against the working directory, so a relative folder
 *   splits the report when a run starts anywhere but the repository root.
 * @throws {@link Error} when `run.reportPath` is relative.
 */
export function reporters(run: RunDescription): ReporterDescription[] {
  const reportDir = run.reportPath;
  if (!isAbsolute(reportDir)) {
    throw new Error(
      `[reporting] The report folder must be absolute, got "${reportDir}": a relative one ` +
        "would send Allure's results to wherever the run was started.",
    );
  }
  const rich = env("REPORT_MODE") === "rich";
  return [
    [ownReporter("cell-notice.ts"), run],
    [ownReporter("results-stream.ts"), run],
    ["list"],
    ["html", { outputFolder: `${reportDir}/playwright`, open: "never" }],
    cucumberReporter("html", {
      outputFile: `${reportDir}/cucumber/index.html`,
      externalAttachments: rich,
      skipAttachments: rich ? false : ["application/zip"],
    }),
    ["allure-playwright", { resultsDir: `${reportDir}/allure-results` }],
    [ownReporter("run-summary.ts"), run],
  ];
}
