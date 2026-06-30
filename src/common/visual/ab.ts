import { test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

import {
  DEFAULT_MAX_DIFF_PIXEL_RATIO,
  DEFAULT_PIXEL_THRESHOLD,
} from "../config/visual";
import { ImageDimensionsMismatchError, comparePng } from "./compare";
import type { PixelDiffResult } from "./compare";
import { stabilizeForSnapshot } from "./stabilize";

/**
 * A/B visual check (plan §7.6): assert a page renders the SAME with the optimizing plugin active as
 * with it bypassed (WP Rocket's `?nowprocket`). Both renders are captured live in one run and
 * diffed against each other — there is no committed baseline, so nothing to `--update-snapshots`.
 * This is what proves an optimization (lazy-load, CSS/JS handling, …) is visually transparent, and
 * it is the model the WP Rocket suite actually uses.
 */

/** Options for {@link expectOptimizedToMatchUnoptimized}. */
export interface OptimizationVisualOptions {
  /** Query flag that disables the plugin's optimizations. Default `"nowprocket"` (WP Rocket). */
  readonly bypassParam?: string;
  /** Locators painted over in BOTH captures — for regions that legitimately differ / are volatile. */
  readonly mask?: readonly Locator[];
  /** Max share of pixels (0–1) allowed to differ. Default {@link DEFAULT_MAX_DIFF_PIXEL_RATIO}. */
  readonly maxDiffPixelRatio?: number;
  /** Per-pixel color sensitivity (0–1). Default {@link DEFAULT_PIXEL_THRESHOLD}. */
  readonly threshold?: number;
}

/**
 * Append the optimization-bypass flag (e.g. `?nowprocket`) to `url`, preserving query + fragment.
 * String-level on purpose: `url` may be RELATIVE (resolved later against baseURL), which `new URL()`
 * rejects without a base, and the flag must stay bare (`URLSearchParams` would emit `nowprocket=`).
 */
function withBypassFlag(url: string, flag: string): string {
  const hashAt = url.indexOf("#");
  const base = hashAt >= 0 ? url.slice(0, hashAt) : url;
  const fragment = hashAt >= 0 ? url.slice(hashAt) : "";
  const separator = base.includes("?") ? "&" : "?";
  return `${base}${separator}${flag}${fragment}`;
}

/**
 * Settle `page` and capture a full-page PNG. Exposed so callers can build custom A/B comparisons
 * (e.g. before/after an action) on top of {@link comparePng}.
 */
export async function captureFullPage(
  page: Page,
  options: { mask?: readonly Locator[]; lazyLoad?: boolean } = {},
): Promise<Buffer> {
  await stabilizeForSnapshot(page, options.lazyLoad ?? true);
  return page.screenshot({
    fullPage: true,
    ...(options.mask ? { mask: [...options.mask] } : {}),
  });
}

/** Attach both renders (and the diff, if any) to the report — best-effort, never masks a failure. */
async function attachDiagnostics(
  reference: Buffer,
  actual: Buffer,
  diff: Buffer | undefined,
  bypassParam: string,
): Promise<void> {
  try {
    const info = test.info();
    await info.attach(`unoptimized (?${bypassParam})`, {
      body: reference,
      contentType: "image/png",
    });
    await info.attach("optimized", { body: actual, contentType: "image/png" });
    if (diff) {
      await info.attach("diff", { body: diff, contentType: "image/png" });
    }
  } catch {
    // Not running under the test runner, or attach failed: diagnostics are optional.
  }
}

/**
 * Assert the optimized render of `url` matches its unoptimized (`?<bypassParam>`) render.
 *
 * Captures the bypassed page first (the reference), then the optimized page, stabilising each
 * (lazy-load + fonts) so both are fully painted, and pixel-diffs them. On failure it attaches both
 * renders plus a highlighted diff to the report.
 *
 * `url` may be relative (resolved against the cell's `baseURL`) or absolute.
 *
 * @throws when the renders differ by more than `maxDiffPixelRatio`, or differ in size (a layout
 *   change is itself a regression).
 */
export async function expectOptimizedToMatchUnoptimized(
  page: Page,
  url: string,
  options: OptimizationVisualOptions = {},
): Promise<void> {
  const bypassParam = options.bypassParam ?? "nowprocket";
  const maxRatio = options.maxDiffPixelRatio ?? DEFAULT_MAX_DIFF_PIXEL_RATIO;
  const threshold = options.threshold ?? DEFAULT_PIXEL_THRESHOLD;

  // Reference: plugin bypassed — the "raw" render the optimized page must match.
  await page.goto(withBypassFlag(url, bypassParam));
  const reference = await captureFullPage(page, { mask: options.mask });

  // Actual: the optimized render.
  await page.goto(url);
  const actual = await captureFullPage(page, { mask: options.mask });

  let result: PixelDiffResult | undefined;
  let failure: string | undefined;
  try {
    result = comparePng(reference, actual, { threshold });
    if (result.ratio > maxRatio) {
      const pct = (result.ratio * 100).toFixed(2);
      const max = (maxRatio * 100).toFixed(2);
      failure = `optimized render differs from ?${bypassParam} by ${pct}% of pixels (max ${max}%)`;
    }
  } catch (error) {
    // A size difference is a real regression, not a crash — report it as a failure.
    if (error instanceof ImageDimensionsMismatchError) failure = error.message;
    else throw error;
  }

  if (failure !== undefined) {
    await attachDiagnostics(reference, actual, result?.diffImage, bypassParam);
    throw new Error(`[visual a/b] ${url}: ${failure}`);
  }
}
