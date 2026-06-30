import { expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

import { stabilizeForSnapshot } from "./stabilize";

/**
 * Committed-baseline visual checks over Playwright's `toHaveScreenshot()` — capture once, compare
 * future runs against the committed image. This is the general "does this page still look like its
 * approved baseline" capability; WP Rocket's own checks instead use the A/B model in ./ab.ts.
 *
 * `toHaveScreenshot` already disables animations, hides the caret, and retries until two
 * consecutive captures are identical; these helpers add lazy-load/font stabilisation, masking, and
 * one tuned call site. Tolerance and baseline location live in ../config/visual.ts.
 */

/** Options shared by the page/element matchers. */
export interface VisualMatchOptions {
  /** Locators painted over before comparing — for volatile regions (dates, ads, carousels). */
  readonly mask?: readonly Locator[];
  /** Scroll the page first to trigger lazy-loaded images/iframes. Default: true. */
  readonly lazyLoad?: boolean;
  /** Override the global pixel-difference tolerance (0–1) for this assertion. */
  readonly maxDiffPixelRatio?: number;
  /** Override the per-pixel color threshold (0 strict … 1 lax) for this assertion. */
  readonly threshold?: number;
}

/** The `toHaveScreenshot` options common to both matchers, from {@link VisualMatchOptions}. */
function comparisonOptions(options: VisualMatchOptions): {
  mask?: Locator[];
  maxDiffPixelRatio?: number;
  threshold?: number;
} {
  return {
    ...(options.mask ? { mask: [...options.mask] } : {}),
    ...(options.maxDiffPixelRatio !== undefined
      ? { maxDiffPixelRatio: options.maxDiffPixelRatio }
      : {}),
    ...(options.threshold !== undefined
      ? { threshold: options.threshold }
      : {}),
  };
}

/**
 * Assert the whole page matches its committed baseline `name` (e.g. `"homepage.png"`).
 * Stabilises first (lazy-load + fonts), then compares the full scrollable page.
 */
export async function expectPageToMatch(
  page: Page,
  name: string,
  options: VisualMatchOptions = {},
): Promise<void> {
  await stabilizeForSnapshot(page, options.lazyLoad ?? true);
  await expect(page).toHaveScreenshot(name, {
    fullPage: true,
    ...comparisonOptions(options),
  });
}

/**
 * Assert a single element matches its committed baseline `name`. Page-level lazy-load scrolling is
 * off by default here (an element check is usually above the fold); enable it via `lazyLoad`.
 */
export async function expectElementToMatch(
  locator: Locator,
  name: string,
  options: VisualMatchOptions = {},
): Promise<void> {
  await stabilizeForSnapshot(locator.page(), options.lazyLoad ?? false);
  await expect(locator).toHaveScreenshot(name, comparisonOptions(options));
}
