import { defineConfig } from "allure";

/**
 * Allure 3 report configuration (read by the `allure` CLI — see `scripts/allure.mjs`).
 *
 * The `allure-playwright` reporter only writes RAW results; this file controls how they are
 * turned into a report. Per-run paths are supplied by `scripts/allure.mjs`: the output dir on
 * the CLI (`-o`), and `ALLURE_HISTORY` pointing at the cell-level history file that accumulates
 * across runs — what makes the trend chart span multiple runs.
 */
const historyPath = process.env.ALLURE_HISTORY || "allure-history.jsonl";

export default defineConfig({
  name: "WP Media E2E",
  historyPath,
  // Triage buckets: surface tests that only passed on retry as flaky (not hidden among passes),
  // and separate assertion failures from unexpected errors.
  categories: [
    { name: "Flaky tests", matchers: { flaky: true } },
    { name: "Product defects", matchers: { statuses: ["failed"] } },
    { name: "Test defects", matchers: { statuses: ["broken"] } },
  ],
  plugins: {
    // The main interactive report; `singleFile` → one portable, self-contained HTML.
    awesome: {
      options: { singleFile: true, reportLanguage: "en" },
    },
    // A configurable overview: status trend across runs + a results pie.
    dashboard: {
      options: {
        singleFile: true,
        reportLanguage: "en",
        layout: [
          { type: "trend", dataType: "status", mode: "percent" },
          { type: "pie", title: "Test Results" },
        ],
      },
    },
  },
});
