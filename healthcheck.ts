import "./src/common/config/load-env";

import { styleText } from "node:util";

import { chromium } from "@playwright/test";
import type { Browser } from "@playwright/test";

import { loginViaUi } from "./src/common/auth/login";
import { boolEnv, intEnv } from "./src/common/config/env";
import { isPlaceholderSite } from "./src/common/config/sites";
import type {
  ProductConfig,
  SiteInput,
  Transport,
} from "./src/common/config/types";
import {
  transportLabel,
  verifySite,
  warnAboutElevation,
  warnAboutPluginDirs,
} from "./src/common/setup/preflight";
import { resolveIdentity } from "./src/common/artifacts/manifest";
import type { CheckResult } from "./src/common/setup/preflight";
import type { ElevationSupport } from "./src/common/wp/exec";
import { disposeConnections } from "./src/common/wp/exec";
import { redactSecrets } from "./src/common/text";
import { PRODUCTS } from "./src/projects/products";

/**
 * Fleet-wide health check: for every product × cell × site, verifies the transport
 * (SSH/Docker/local reachable, WP-CLI works, WordPress is installed — see
 * `src/common/setup/preflight.ts`) and then exercises a real login through the
 * WordPress UI (`src/common/auth/login.ts`). No `storageState` is ever written —
 * this never touches `.auth/`, it only reports whether each site is reachable and
 * usable.
 *
 * Output is grouped BY PRODUCT: each product prints its own section (its sites, each
 * with the individual checks that ran, plus a per-product tally) and the final
 * summary breaks the fleet down per product too, so wp-rocket / backwpup / (future)
 * imagify never blur together. Products are processed one at a time so each section
 * stays contiguous; the sites WITHIN a product run concurrently (bounded by
 * `HEALTHCHECK_CONCURRENCY`).
 *
 * One site's failure never aborts the run: every site is checked independently, its
 * result is printed as soon as it is known, and the summary aggregates all of them.
 * The process exits non-zero if ANY real site failed, so this is safe to wire into
 * CI/cron as a fleet monitor. Cells with no real sites configured yet
 * (placeholder/example data — see `sites.example.json`) are reported as skipped, not
 * failed: that is expected on a fresh checkout, not a fleet problem.
 *
 * Usage: `npm run healthcheck` (headless) or `npm run healthcheck:ui` (headed — the browser is
 * visible on screen so you can watch each login; everything else is identical).
 */

// Bounded so a large fleet does not open unbounded SSH connections / browser contexts
// at once. Override with HEALTHCHECK_CONCURRENCY for bigger/smaller fleets.
const CONCURRENCY = intEnv("HEALTHCHECK_CONCURRENCY", 4, 1, 32);

// Per-login settle budget (ms). Playwright's default `expect` timeout (5s) is too tight
// for a slow remote (SSH-hosted) site's POST → dashboard redirect; a monitor favours
// patience over speed. Override with HEALTHCHECK_LOGIN_TIMEOUT_MS.
const LOGIN_TIMEOUT_MS = intEnv(
  "HEALTHCHECK_LOGIN_TIMEOUT_MS",
  30_000,
  1_000,
  300_000,
);

// When true, run the browser headed (a real window on screen) so each login is visible instead of
// running invisibly. Set by `npm run healthcheck:ui` (which passes `--headed`) or
// HEALTHCHECK_HEADED=true. Nothing else changes — same checks, same output, same exit code.
const HEADED =
  process.argv.includes("--headed") || boolEnv("HEALTHCHECK_HEADED", false);

const RULE = "─".repeat(72);

// ── Discovery ────────────────────────────────────────────────────────────────────

/** One checkable site: which product/cell it belongs to, the site itself, and its pool index. */
interface SiteTask {
  readonly product: string;
  readonly cell: string;
  readonly site: SiteInput;
  readonly index: number;
  /** The slug the cell installs as — whose folder the check looks at, and its @plugin scenarios clear. */
  readonly slugs: readonly string[];
}

/** A cell that has no real sites to check (placeholder-only, or the product declares no cells). */
interface CellSkip {
  readonly product: string;
  readonly cell: string;
  readonly reason: string;
}

/** Everything to do for one product: the sites to check and the cells that were skipped. */
interface ProductPlan {
  readonly product: string;
  readonly tasks: SiteTask[];
  readonly skips: CellSkip[];
}

/** Splits every product's cells into checkable sites vs. skipped (placeholder-only) cells, one plan per product. */
function discover(products: readonly ProductConfig[]): ProductPlan[] {
  return products.map((product) => {
    const tasks: SiteTask[] = [];
    const skips: CellSkip[] = [];
    const cells = Object.keys(product.sites);

    if (cells.length === 0) {
      skips.push({
        product: product.name,
        cell: "(none)",
        reason: "no cells configured",
      });
    }

    for (const cell of cells) {
      const pool = product.sites[cell]?.sites ?? [];
      const real = pool
        .map((site, index) => ({ site, index }))
        .filter(({ site }) => !isPlaceholderSite(site));

      if (real.length === 0) {
        skips.push({
          product: product.name,
          cell,
          reason: "no real sites configured (placeholder/example data)",
        });
        continue;
      }

      const { slug } = resolveIdentity(
        product.artifacts,
        product.sites[cell]?.edition,
      );
      for (const { site, index } of real) {
        tasks.push({ product: product.name, cell, site, index, slugs: [slug] });
      }
    }

    return { product: product.name, tasks, skips };
  });
}

// ── Per-site checking ────────────────────────────────────────────────────────────

/** The full outcome for one site: its identity, every check run against it, timing, and pass/fail. */
interface SiteResult {
  readonly product: string;
  readonly cell: string;
  readonly index: number;
  readonly baseURL: string;
  readonly transport: Transport;
  readonly checks: CheckResult[];
  readonly durationMs: number;
  readonly ok: boolean;
  /**
   * What privileges this site's transport reached, when it got far enough to be asked. Carried so
   * the fleet run can close with the same elevation warning a suite run prints, from the same
   * renderer — a fleet monitor is exactly where "half the fleet cannot clean up after itself" should
   * be impossible to miss.
   */
  readonly elevation?: ElevationSupport;
  /**
   * Whether this site's files actually need handing to another owner. Carried for the same reason
   * {@link SitePreflightResult} carries it: the run-level banner states the ownership cost only for
   * the sites where it is true, and a fleet check that dropped it would quietly claim the cost for
   * none of them.
   */
  readonly ownershipPending?: boolean;
  /** Folders at the cell's slug that WordPress lists no plugin in, for the closing warning. */
  readonly leftoverPluginDirs?: readonly string[];
}

/** Logs in through the WordPress UI in a throwaway browser context; never persists state. */
async function checkLogin(
  browser: Browser,
  site: SiteInput,
): Promise<CheckResult> {
  const context = await browser.newContext({ baseURL: site.baseURL });
  try {
    const page = await context.newPage();
    await loginViaUi(page, site, { timeoutMs: LOGIN_TIMEOUT_MS });
    return {
      name: "WordPress login",
      ok: true,
      detail: "Logged in via wp-login.php and reached wp-admin.",
    };
  } catch (err) {
    // Playwright errors often append a multi-line "Call log:" block to `.message`;
    // keep the report's per-check line to the summary, which is self-contained.
    const raw = err instanceof Error ? err.message : String(err);
    const msg = (raw.split("\n")[0] ?? raw).trim();
    return {
      name: "WordPress login",
      ok: false,
      detail: `Could not log in: ${msg}`,
      hint: [
        "Confirm the site's username/password in sites.json are correct and the",
        "account is not locked, disabled, or gated behind extra auth (2FA / a security plugin).",
      ].join("\n"),
    };
  } finally {
    await context.close();
  }
}

/** Runs preflight + login for one site. Login only runs if every preflight check passed. */
async function checkSite(
  browser: Browser,
  task: SiteTask,
): Promise<SiteResult> {
  const start = Date.now();
  const preflight = await verifySite(task.site, task.index, task.slugs);
  const checks: CheckResult[] = [...preflight.checks];

  if (checks.every((c) => c.ok)) {
    checks.push(await checkLogin(browser, task.site));
  } else {
    checks.push({
      name: "WordPress login",
      ok: false,
      detail: "Skipped — transport verification failed above.",
    });
  }

  return {
    product: task.product,
    cell: task.cell,
    index: task.index,
    baseURL: task.site.baseURL,
    transport: task.site.transport,
    checks,
    durationMs: Date.now() - start,
    ok: checks.every((c) => c.ok),
    ...(preflight.elevation !== undefined
      ? { elevation: preflight.elevation }
      : {}),
    ...(preflight.ownershipPending !== undefined
      ? { ownershipPending: preflight.ownershipPending }
      : {}),
    ...(preflight.leftoverPluginDirs !== undefined
      ? { leftoverPluginDirs: preflight.leftoverPluginDirs }
      : {}),
  };
}

/** Converts an unexpected throw (a bug, not a check failure) into a failed result instead of crashing the run. */
function crashResult(task: SiteTask, err: unknown): SiteResult {
  const msg = err instanceof Error ? err.message : String(err);
  return {
    product: task.product,
    cell: task.cell,
    index: task.index,
    baseURL: task.site.baseURL,
    transport: task.site.transport,
    checks: [
      { name: "Health check", ok: false, detail: `Unexpected error: ${msg}` },
    ],
    durationMs: 0,
    ok: false,
  };
}

// ── Bounded concurrency ────────────────────────────────────────────────────────────

/** Runs at most `concurrency` async tasks at once; excess calls queue in submission order. */
type Limiter = <T>(fn: () => Promise<T>) => Promise<T>;

/** Builds a {@link Limiter} that never has more than `concurrency` calls in flight. */
function createLimiter(concurrency: number): Limiter {
  let active = 0;
  const queue: (() => void)[] = [];

  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= concurrency) {
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    active += 1;
    try {
      return await fn();
    } finally {
      active -= 1;
      const next = queue.shift();
      if (next !== undefined) next();
    }
  };
}

/** Checks all of one product's sites concurrently (bounded by `limit`), printing each as it finishes. */
async function runProduct(
  browser: Browser,
  plan: ProductPlan,
  limit: Limiter,
): Promise<SiteResult[]> {
  return Promise.all(
    plan.tasks.map((task) =>
      limit(async () => {
        const result = await checkSite(browser, task).catch((err: unknown) =>
          crashResult(task, err),
        );
        printSiteResult(result);
        return result;
      }),
    ),
  );
}

// ── Reporting ────────────────────────────────────────────────────────────────────

/** The human-readable identity of a site, e.g. `backwpup/pro@nginx · site[0] https://… [ssh: user@host]`. */
function siteLabel(
  result: Pick<
    SiteResult,
    "product" | "cell" | "index" | "baseURL" | "transport"
  >,
): string {
  return `${result.product}/${result.cell} · site[${String(result.index)}] ${redactSecrets(result.baseURL)} [${transportLabel(result.transport)}]`;
}

/** Prints the top banner and the fleet-wide counts about to be checked. */
function printHeader(plans: readonly ProductPlan[]): void {
  const siteCount = plans.reduce((n, p) => n + p.tasks.length, 0);
  const cellCount = new Set(
    plans.flatMap((p) => p.tasks.map((t) => `${t.product}/${t.cell}`)),
  ).size;
  const productCount = plans.length;

  console.log(styleText(["bold", "cyan"], RULE));
  console.log(styleText(["bold", "cyan"], "  wp-media-e2e — Health Check"));
  console.log(styleText(["bold", "cyan"], RULE));
  console.log(
    styleText(
      ["dim"],
      `  Preflight (transport + WordPress) and login checks across ${String(siteCount)} ` +
        `site(s) in ${String(cellCount)} cell(s), ${String(productCount)} product(s).`,
    ),
  );
  console.log("");
}

/** Prints a per-product section divider so each product's output is visually self-contained. */
function printProductHeader(product: string): void {
  const prefix = `── ${product} `;
  const fill = "─".repeat(Math.max(0, RULE.length - prefix.length));
  console.log(styleText(["bold", "magenta"], `${prefix}${fill}`));
  console.log("");
}

/** Prints one skipped cell (placeholder-only) — informational, never a failure. */
function printSkip(skip: CellSkip): void {
  console.log(
    `  ${styleText(["yellow", "bold"], "⚠")} ${skip.product}/${skip.cell} — ` +
      `${styleText(["yellow"], "skipped")}: ${skip.reason}`,
  );
}

/** Prints one check as an indented ✓/✗ line, with its hint (failures only) on further-indented → lines. */
function printCheckLine(check: CheckResult): void {
  if (check.ok) {
    console.log(
      `      ${styleText(["green"], "✓")} ${check.name}: ${check.detail}`,
    );
    return;
  }
  console.log(
    `      ${styleText(["red"], "✗")} ${styleText(["bold"], check.name)}: ${check.detail}`,
  );
  if (check.hint !== undefined) {
    for (const hintLine of check.hint.split("\n")) {
      console.log(`        ${styleText(["yellow"], "→")} ${hintLine}`);
    }
  }
}

/**
 * Prints one site's result the moment it is known. Passes AND failures both enumerate their
 * individual checks, so a green site still shows exactly WHAT was verified (SSH, rootDir,
 * WordPress, login), not merely that it passed — with an `n/m checks` tally on the headline.
 */
function printSiteResult(result: SiteResult): void {
  const label = siteLabel(result);
  const duration = styleText(
    ["dim"],
    `(${(result.durationMs / 1000).toFixed(1)}s)`,
  );
  const passedChecks = result.checks.filter((c) => c.ok).length;
  const tally = styleText(
    ["dim"],
    `${String(passedChecks)}/${String(result.checks.length)} checks`,
  );

  if (result.ok) {
    console.log(
      `  ${styleText(["green", "bold"], "✔")} ${label} · ${tally} ${duration}`,
    );
  } else {
    console.log(
      `  ${styleText(["red", "bold"], "✖")} ${styleText(["bold"], label)} · ${tally} ${duration}`,
    );
  }

  for (const check of result.checks) printCheckLine(check);
  console.log("");
}

/** Prints a product's own tally right after its section — passed/failed sites and skipped cells. */
function printProductSubSummary(
  plan: ProductPlan,
  results: readonly SiteResult[],
): void {
  const failed = results.filter((r) => !r.ok).length;
  const passed = results.length - failed;
  const skipNote =
    plan.skips.length > 0
      ? `, ${String(plan.skips.length)} cell(s) skipped`
      : "";

  let summary: string;
  if (results.length === 0) {
    const note =
      plan.skips.length > 0
        ? ` (${String(plan.skips.length)} cell(s) skipped)`
        : "";
    summary = styleText(["yellow"], `no real sites to check${note}`);
  } else if (failed === 0) {
    summary = styleText(
      ["green", "bold"],
      `${String(passed)}/${String(results.length)} site(s) passed${skipNote}`,
    );
  } else {
    summary =
      `${styleText(["red", "bold"], `${String(failed)} failed`)}, ` +
      `${String(passed)}/${String(results.length)} passed${skipNote}`;
  }

  console.log(`  ${styleText(["bold"], `${plan.product}:`)} ${summary}`);
}

/** Prints the final per-product breakdown + fleet totals, and returns whether the fleet is healthy. */
function printOverallSummary(
  plans: readonly ProductPlan[],
  allResults: readonly SiteResult[],
  elapsedMs: number,
): boolean {
  const failed = allResults.filter((r) => !r.ok);
  const passed = allResults.length - failed.length;
  const totalSkips = plans.reduce((n, p) => n + p.skips.length, 0);
  const nameWidth = Math.max(0, ...plans.map((p) => p.product.length));

  console.log(styleText(["bold"], RULE));
  console.log(styleText(["bold"], "  Summary"));
  console.log(styleText(["bold"], RULE));

  // Per-product breakdown — never mixes one product's sites with another's.
  for (const plan of plans) {
    const results = allResults.filter((r) => r.product === plan.product);
    const productFailed = results.filter((r) => !r.ok).length;
    const productPassed = results.length - productFailed;
    const icon =
      productFailed > 0
        ? styleText(["red", "bold"], "✖")
        : results.length > 0
          ? styleText(["green", "bold"], "✔")
          : styleText(["yellow", "bold"], "⚠");
    const parts = [
      `${String(productPassed)}/${String(results.length)} site(s) passed`,
    ];
    if (plan.skips.length > 0) {
      parts.push(`${String(plan.skips.length)} cell(s) skipped`);
    }
    console.log(
      `  ${icon} ${styleText(["bold"], plan.product.padEnd(nameWidth))}  ${parts.join(" · ")}`,
    );
  }

  console.log("");
  console.log(
    `  ${styleText(["green", "bold"], String(passed))} passed, ` +
      `${styleText(failed.length > 0 ? ["red", "bold"] : ["dim"], String(failed.length))} failed, ` +
      `${styleText(["yellow", "bold"], String(totalSkips))} skipped ` +
      styleText(["dim"], `— ${(elapsedMs / 1000).toFixed(1)}s total`),
  );
  console.log("");

  if (failed.length > 0) {
    console.log(
      styleText(
        ["red", "bold"],
        `  ${String(failed.length)} of ${String(allResults.length)} site(s) failed. See details above.`,
      ),
    );
  } else if (allResults.length > 0) {
    console.log(
      styleText(
        ["green", "bold"],
        `  All ${String(allResults.length)} checked site(s) are healthy.`,
      ),
    );
  } else {
    console.log(
      styleText(
        ["yellow", "bold"],
        "  No real sites were configured to check (placeholder/example data only).",
      ),
    );
  }
  console.log("");

  return failed.length === 0;
}

// ── Entry point ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const startedAt = Date.now();
  const plans = discover(PRODUCTS);

  printHeader(plans);

  const totalTasks = plans.reduce((n, p) => n + p.tasks.length, 0);
  // Only pay for a browser when there is at least one real site to log into. `HEADED` shows the
  // window on screen (`npm run healthcheck:ui`); the checks are otherwise identical.
  const browser =
    totalTasks > 0 ? await chromium.launch({ headless: !HEADED }) : null;
  const limit = createLimiter(CONCURRENCY);
  const allResults: SiteResult[] = [];

  try {
    // Products run sequentially so each section's live output stays contiguous; sites within a
    // product run concurrently via `limit`.
    for (const plan of plans) {
      printProductHeader(plan.product);
      for (const skip of plan.skips) printSkip(skip);
      if (plan.skips.length > 0) console.log("");

      let results: SiteResult[] = [];
      if (plan.tasks.length > 0 && browser !== null) {
        results = await runProduct(browser, plan, limit);
      }
      allResults.push(...results);
      printProductSubSummary(plan, results);
      console.log("");
    }

    // Inside the `try`, so a failure while printing a later product still leaves the operator with
    // what was learned about the earlier ones. After every product section and before the summary:
    // a warning buried between two products is one nobody reads, and this is the last thing on
    // screen that is not a verdict. Rendered by the same function a suite run uses, so a fleet check
    // and a run can never disagree — but sent to **stdout**, because unlike a suite run this
    // program's entire output is the report, and `healthcheck > fleet.log` must not drop it.
    warnAboutElevation(allResults, console.log);
    warnAboutPluginDirs(allResults, console.log);
  } finally {
    if (browser !== null) await browser.close();
    disposeConnections();
  }

  const healthy = printOverallSummary(
    plans,
    allResults,
    Date.now() - startedAt,
  );
  process.exit(healthy ? 0 : 1);
}

await main();
