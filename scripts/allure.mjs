#!/usr/bin/env node
// Generate (and optionally serve) the Allure report for a product/cell from its most recent run.
//
//   node scripts/allure.mjs [product] [cell] [--open]
//
// With no product/cell it picks the most recently written results across all cells. The report
// is written next to that run's Playwright/Cucumber reports (`reports/<product>/<cell>/<run>/
// allure`); the trend chart comes from a cell-level history file that accumulates across runs.
// Respects REPORT_ROOT (same as the test config) so it finds custom report roots.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const argv = process.argv.slice(2);
const open = argv.includes("--open");
const [product, cell] = argv.filter((arg) => !arg.startsWith("--"));

const reportRoot = process.env.REPORT_ROOT || "reports";

/** Immediate subdirectory names of `dir` (empty when `dir` is absent). */
function subdirs(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

// Collect every run that has non-empty Allure results, optionally filtered to one product/cell.
const runs = [];
for (const prod of subdirs(reportRoot)) {
  if (product && prod !== product) continue;
  for (const cellName of subdirs(join(reportRoot, prod))) {
    if (cell && cellName !== cell) continue;
    const cellDir = join(reportRoot, prod, cellName);
    for (const runId of subdirs(cellDir)) {
      const resultsDir = join(cellDir, runId, "allure-results");
      if (existsSync(resultsDir) && readdirSync(resultsDir).length > 0) {
        runs.push({
          product: prod,
          cell: cellName,
          cellDir,
          resultsDir,
          output: join(cellDir, runId, "allure"),
          mtime: statSync(resultsDir).mtimeMs,
        });
      }
    }
  }
}

if (runs.length === 0) {
  const scope = [product, cell].filter(Boolean).join("/");
  console.error(
    `No Allure results found under "${reportRoot}/"${scope ? ` for ${scope}` : ""}. ` +
      "Run a suite first, e.g. `E2E_CELL=apache npm run test:wp-rocket`.",
  );
  process.exit(1);
}

// Most recent run wins (so a bare `report:allure` reports whatever you just ran).
runs.sort((a, b) => b.mtime - a.mtime);
const target = runs[0];
const historyPath = join(target.cellDir, "allure-history.jsonl");

console.log(`→ Allure report for ${target.product}/${target.cell}`);
console.log(`  results: ${target.resultsDir}`);
console.log(`  output:  ${target.output}`);
console.log(`  history: ${historyPath}`);

const allureBin = resolve("node_modules", ".bin", "allure");

// `allure generate` reads the cell-level history file (ALLURE_HISTORY, configured in
// allurerc.mjs) to render the trend, then writes this run back into it — so each run's report
// shows the trend across all prior runs. Output is per-run; history is per-cell (shared).
const generateArgs = [
  "generate",
  target.resultsDir,
  "-o",
  target.output,
  "-c",
  "allurerc.mjs",
  "--name",
  `${target.product} · ${target.cell}`, // report header identifies the cell
];
if (open) generateArgs.push("--open");
const generated = spawnSync(allureBin, generateArgs, {
  stdio: "inherit",
  env: { ...process.env, ALLURE_HISTORY: historyPath },
});

// spawnSync signals a spawn failure (e.g. the CLI is missing) via `.error`, not an exit code.
if (generated.error) {
  console.error(
    `Could not run the Allure CLI at ${allureBin}: ${generated.error.message}`,
  );
  process.exit(1);
}
process.exit(generated.status ?? 1);
