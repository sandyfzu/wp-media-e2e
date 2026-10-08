// Open the Playwright HTML report from a product/cell's most recent run.
//
//   npx tsx scripts/report.mjs [product] [cell]
//
// Reports are written per run to `reports/<product>/<cell>/<RUN_ID>/playwright` (never to the
// default `playwright-report/`), so a bare `playwright show-report` would open the wrong (or a
// stale) directory. This resolves the newest run — optionally filtered to one product/cell —
// and serves it. Respects REPORT_ROOT (same as the test config) so it finds custom report roots,
// `.env`'s included: it loads `.env` as a run does, which is why it runs under tsx.
import "../src/common/config/load-env";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const argv = process.argv.slice(2);
const [product, cell] = argv.filter((arg) => !arg.startsWith("--"));

const reportRoot = process.env.REPORT_ROOT || "reports";

/** Immediate subdirectory names of `dir` (empty when `dir` is absent). */
function subdirs(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

// Collect every run that has a non-empty Playwright HTML report, optionally filtered to one
// product/cell.
const runs = [];
for (const prod of subdirs(reportRoot)) {
  if (product && prod !== product) continue;
  for (const cellName of subdirs(join(reportRoot, prod))) {
    if (cell && cellName !== cell) continue;
    const cellDir = join(reportRoot, prod, cellName);
    for (const runId of subdirs(cellDir)) {
      const htmlDir = join(cellDir, runId, "playwright");
      if (existsSync(join(htmlDir, "index.html"))) {
        runs.push({
          product: prod,
          cell: cellName,
          htmlDir,
          mtime: statSync(htmlDir).mtimeMs,
        });
      }
    }
  }
}

if (runs.length === 0) {
  const scope = [product, cell].filter(Boolean).join("/");
  console.error(
    `No Playwright HTML report found under "${reportRoot}/"${scope ? ` for ${scope}` : ""}. ` +
      "Run a suite first, e.g. `E2E_CELL=apache npm run test:wp-rocket`.",
  );
  process.exit(1);
}

// Most recent run wins (so a bare `npm run report` opens whatever you just ran).
runs.sort((a, b) => b.mtime - a.mtime);
const target = runs[0];

console.log(`→ Playwright report for ${target.product}/${target.cell}`);
console.log(`  ${target.htmlDir}`);

const playwrightBin = resolve("node_modules", ".bin", "playwright");
const shown = spawnSync(playwrightBin, ["show-report", target.htmlDir], {
  stdio: "inherit",
});

// spawnSync signals a spawn failure (e.g. the CLI is missing) via `.error`, not an exit code.
if (shown.error) {
  console.error(
    `Could not run the Playwright CLI at ${playwrightBin}: ${shown.error.message}`,
  );
  process.exit(1);
}
process.exit(shown.status ?? 1);
