import "./src/common/config/load-env";

import { styleText } from "node:util";

import { chromium } from "@playwright/test";
import type { Browser } from "@playwright/test";

import { loginViaUi } from "./src/common/auth/login";
import { intEnv } from "./src/common/config/env";
import { isPlaceholderSite } from "./src/common/config/sites";
import type {
  ProductConfig,
  SiteInput,
  Transport,
} from "./src/common/config/types";
import { transportLabel, verifySite } from "./src/common/setup/preflight";
import type { CheckResult } from "./src/common/setup/preflight";
import { disposeConnections } from "./src/common/wp/exec";
import { backwpup } from "./src/projects/backwpup/config/backwpup.config";
import { wpRocket } from "./src/projects/wp-rocket/config/wp-rocket.config";

/**
 * Fleet-wide health check: for every product × cell × site, verifies the transport
 * (SSH/Docker/local reachable, WP-CLI works, WordPress is installed — see
 * `src/common/setup/preflight.ts`) and then exercises a real login through the
 * WordPress UI (`src/common/auth/login.ts`). No `storageState` is ever written —
 * this never touches `.auth/`, it only reports whether each site is reachable and
 * usable.
 *
 * One site's failure never aborts the run: every site is checked independently, its
 * result is printed as soon as it is known, and a final summary aggregates all of
 * them. The process exits non-zero if ANY real site failed, so this is safe to wire
 * into CI/cron as a fleet monitor. Cells with no real sites configured yet
 * (placeholder/example data — see `sites.example.json`) are reported as skipped, not
 * failed: that is expected on a fresh checkout, not a fleet problem.
 *
 * Usage: `npm run healthcheck`.
 */

const PRODUCTS: readonly ProductConfig[] = [wpRocket, backwpup];

// Bounded so a large fleet does not open unbounded SSH connections / browser contexts
// at once. Override with HEALTHCHECK_CONCURRENCY for bigger/smaller fleets.
const CONCURRENCY = intEnv("HEALTHCHECK_CONCURRENCY", 4, 1, 32);

const RULE = "─".repeat(72);

// ── Discovery ────────────────────────────────────────────────────────────────────

interface SiteTask {
  readonly product: string;
  readonly cell: string;
  readonly site: SiteInput;
  readonly index: number;
}

interface CellSkip {
  readonly product: string;
  readonly cell: string;
  readonly reason: string;
}

interface Discovery {
  readonly tasks: SiteTask[];
  readonly skips: CellSkip[];
}

/** Walks every product's cells and splits their pools into checkable sites vs. skipped (placeholder-only) cells. */
function discover(products: readonly ProductConfig[]): Discovery {
  const tasks: SiteTask[] = [];
  const skips: CellSkip[] = [];

  for (const product of products) {
    const cells = Object.keys(product.sites);
    if (cells.length === 0) {
      skips.push({
        product: product.name,
        cell: "(none)",
        reason: "no cells configured",
      });
      continue;
    }

    for (const cell of cells) {
      const cellConfig = product.sites[cell];
      const pool = cellConfig?.sites ?? [];
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

      for (const { site, index } of real) {
        tasks.push({ product: product.name, cell, site, index });
      }
    }
  }

  return { tasks, skips };
}

// ── Per-site checking ────────────────────────────────────────────────────────────

interface SiteResult {
  readonly product: string;
  readonly cell: string;
  readonly index: number;
  readonly baseURL: string;
  readonly transport: Transport;
  readonly checks: CheckResult[];
  readonly durationMs: number;
  readonly ok: boolean;
}

/** Logs in through the WordPress UI in a throwaway browser context; never persists state. */
async function checkLogin(
  browser: Browser,
  site: SiteInput,
): Promise<CheckResult> {
  const context = await browser.newContext({ baseURL: site.baseURL });
  try {
    const page = await context.newPage();
    await loginViaUi(page, site);
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
  const preflight = await verifySite(task.site, task.index);
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

/** Runs `fn` values with at most `concurrency` in flight; excess calls queue in submission order. */
function createLimiter(
  concurrency: number,
): <T>(fn: () => Promise<T>) => Promise<T> {
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

// ── Reporting ────────────────────────────────────────────────────────────────────

function siteLabel(
  result: Pick<
    SiteResult,
    "product" | "cell" | "index" | "baseURL" | "transport"
  >,
): string {
  return `${result.product}/${result.cell} · site[${String(result.index)}] ${result.baseURL} [${transportLabel(result.transport)}]`;
}

function printHeader(discovery: Discovery): void {
  const productCount = new Set(discovery.tasks.map((t) => t.product)).size;
  const cellCount = new Set(
    discovery.tasks.map((t) => `${t.product}/${t.cell}`),
  ).size;

  console.log(styleText(["bold", "cyan"], RULE));
  console.log(
    styleText(["bold", "cyan"], "  wp-media-projects-e2e — Health Check"),
  );
  console.log(styleText(["bold", "cyan"], RULE));
  console.log(
    styleText(
      ["dim"],
      `  Preflight (transport + WordPress) and login checks across ${String(discovery.tasks.length)} ` +
        `site(s) in ${String(cellCount)} cell(s), ${String(productCount)} product(s).`,
    ),
  );
  console.log("");
}

function printSkip(skip: CellSkip): void {
  console.log(
    `  ${styleText(["yellow", "bold"], "⚠")} ${skip.product}/${skip.cell} — ` +
      `${styleText(["yellow"], "skipped")}: ${skip.reason}`,
  );
}

/** Prints one site's result the moment it is known — passes are one line, failures expand into their checks. */
function printSiteResult(result: SiteResult): void {
  const label = siteLabel(result);
  const duration = styleText(
    ["dim"],
    `(${(result.durationMs / 1000).toFixed(1)}s)`,
  );

  if (result.ok) {
    console.log(`  ${styleText(["green", "bold"], "✔")} ${label} ${duration}`);
    return;
  }

  console.log(
    `  ${styleText(["red", "bold"], "✖")} ${styleText(["bold"], label)} ${duration}`,
  );
  for (const check of result.checks) {
    if (check.ok) {
      console.log(
        `      ${styleText(["green"], "✓")} ${check.name}: ${check.detail}`,
      );
      continue;
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
  console.log("");
}

/** Groups results by "product/cell" in first-seen order (a plain object would work too, but this keeps insertion order explicit). */
function groupByCell(
  results: readonly SiteResult[],
): Map<string, SiteResult[]> {
  const groups = new Map<string, SiteResult[]>();
  for (const result of results) {
    const key = `${result.product}/${result.cell}`;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, [result]);
    } else {
      group.push(result);
    }
  }
  return groups;
}

/** Prints the final recap and returns whether the whole fleet is healthy (no real site failed). */
function printSummary(
  results: readonly SiteResult[],
  skips: readonly CellSkip[],
  elapsedMs: number,
): boolean {
  const failed = results.filter((r) => !r.ok);
  const passed = results.length - failed.length;

  console.log(styleText(["bold"], RULE));
  console.log(styleText(["bold"], "  Summary"));
  console.log(styleText(["bold"], RULE));

  for (const [cell, group] of groupByCell(results)) {
    const cellFailed = group.filter((r) => !r.ok).length;
    const icon =
      cellFailed === 0
        ? styleText(["green", "bold"], "✔")
        : styleText(["red", "bold"], "✖");
    console.log(
      `  ${icon} ${cell}: ${String(group.length - cellFailed)}/${String(group.length)} site(s) passed`,
    );
  }
  for (const skip of skips) {
    console.log(
      `  ${styleText(["yellow", "bold"], "⚠")} ${skip.product}/${skip.cell}: skipped — ${skip.reason}`,
    );
  }

  console.log("");
  console.log(
    `  ${styleText(["green", "bold"], String(passed))} passed, ` +
      `${styleText(failed.length > 0 ? ["red", "bold"] : ["dim"], String(failed.length))} failed, ` +
      `${styleText(["yellow", "bold"], String(skips.length))} skipped ` +
      styleText(["dim"], `— ${(elapsedMs / 1000).toFixed(1)}s total`),
  );
  console.log("");

  if (failed.length > 0) {
    console.log(
      styleText(
        ["red", "bold"],
        `  ${String(failed.length)} of ${String(results.length)} site(s) failed. See details above.`,
      ),
    );
  } else if (results.length > 0) {
    console.log(
      styleText(
        ["green", "bold"],
        `  All ${String(results.length)} checked site(s) are healthy.`,
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
  const discovery = discover(PRODUCTS);

  printHeader(discovery);
  for (const skip of discovery.skips) printSkip(skip);
  if (discovery.skips.length > 0) console.log("");

  if (discovery.tasks.length === 0) {
    const healthy = printSummary([], discovery.skips, Date.now() - startedAt);
    process.exit(healthy ? 0 : 1);
  }

  const browser = await chromium.launch({ headless: true });
  const limit = createLimiter(CONCURRENCY);

  let results: SiteResult[];
  try {
    results = await Promise.all(
      discovery.tasks.map((task) =>
        limit(async () => {
          const result = await checkSite(browser, task).catch((err: unknown) =>
            crashResult(task, err),
          );
          printSiteResult(result);
          return result;
        }),
      ),
    );
  } finally {
    await browser.close();
    disposeConnections();
  }

  const healthy = printSummary(
    results,
    discovery.skips,
    Date.now() - startedAt,
  );
  process.exit(healthy ? 0 : 1);
}

await main();
