import { join } from "node:path";

import { test as setup } from "@playwright/test";
import type { TestInfo } from "@playwright/test";

import { getPool, readRouting } from "../config/metadata";
import { isPlaceholderSite } from "../config/sites";
import { REPO_ROOT, dirs, selectedCells } from "../config/run-context";
import { getManifest, registerArtifacts } from "./registry";
import { buildArtifactPlan, readArtifactEnv } from "./request";
import { resolveArtifacts, writeResolutionFile } from "./resolve";
import {
  formatFailureReport,
  formatSuccessSummary,
  reportSummary,
  verifyResolved,
} from "./verify";

/**
 * Plugin-artifact setup project (plain Playwright, sibling of the auth setup). For the cell's
 * product it resolves the zips under test — building git refs through APVM or copying provided
 * zips into a wiped `.artifacts/<product>/<cell>/` dir — then runs the static identity preflight
 * over all of them and writes `resolution.json` for the worker processes that consume it.
 *
 * The BDD project depends on this **and** on the auth setup independently, so either failing
 * skips the scenarios (plan §2.6). Placeholder-only cells skip entirely, exactly like auth, so a
 * fresh checkout's `npm run test` clones/builds nothing and needs no GitHub token.
 *
 * Errors are aggregated: every role is resolved and verified even when an earlier one fails, then
 * a single formatted report is thrown (plan §2.5). Cold builds run composer/npm, so the timeout
 * is generous.
 */
setup(
  "resolve & verify plugin artifacts",
  // Playwright requires an object-destructuring first arg; this test needs no fixtures
  // (no browser, no site) — routing comes from testInfo.
  // eslint-disable-next-line no-empty-pattern -- required destructuring; intentionally empty.
  async ({}, testInfo) => {
    const { product, cell, edition } = readRouting(testInfo.project.metadata);

    // Skip on placeholder-only pools, mirroring auth: no real cell ⇒ nothing to build or verify.
    const real = getPool(product, cell).filter(
      (site) => !isPlaceholderSite(site),
    );
    setup.skip(
      real.length === 0,
      `No real sites configured for "${product}/${cell}" (placeholder example data ` +
        "in use) — skipping artifact resolution. Create sites.json for real runs.",
    );

    // Cold builds clone repos and run composer/npm; allow ~20 min before failing spuriously.
    setup.setTimeout(20 * 60_000);

    const manifest = getManifest(product);
    // Serial (cell-less) runs use defaults and only warn about overrides (plan §2.2 rule 3): this
    // cell counts as serial unless it was the one explicitly selected via --project.
    const serial = !selectedCells().includes(cell);

    // A ref+zip conflict in a cell run throws here (fail-fast, plan §2.8 case 1); inert/ignored
    // vars come back as warnings to surface.
    const plan = buildArtifactPlan({
      product: manifest,
      edition,
      serial,
      env: readArtifactEnv(),
    });
    for (const warning of plan.warnings) console.warn(warning);

    const artifactsDir = join(REPO_ROOT, dirs(product, cell).artifacts);
    const outcomes = await resolveArtifacts({
      requests: plan.requests,
      artifactsDir,
    });
    const report = verifyResolved(outcomes, manifest, edition);

    // Attach the JSON summary to the report (diagnostic only — never mask the real result).
    await attachSummary(testInfo, reportSummary(report, product, cell));

    if (!report.ok) throw new Error(formatFailureReport(report, product, cell));

    // Success: persist for worker processes, memoize in-process, and log a concise summary.
    await writeResolutionFile(artifactsDir, report.resolved);
    registerArtifacts(product, cell, report.artifacts);
    console.log(formatSuccessSummary(report, product, cell));
  },
);

/** Best-effort JSON attachment of the resolution summary, so it lands in HTML/Allure reports. */
async function attachSummary(
  testInfo: TestInfo,
  summary: unknown,
): Promise<void> {
  try {
    await testInfo.attach("artifacts-resolution.json", {
      body: JSON.stringify(summary, null, 2),
      contentType: "application/json",
    });
  } catch {
    // An attachment failure must never fail artifact resolution.
  }
}
