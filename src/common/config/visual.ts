import type { PlaywrightTestConfig } from "@playwright/test";

/**
 * Shared visual-comparison tolerances and config. Used by BOTH visual models so they
 * fail at the same sensitivity:
 *  - the optimized-vs-unoptimized A/B check (`src/common/visual/ab.ts`) — what WP Rocket uses, and
 *  - committed-baseline `toHaveScreenshot` (via {@link VISUAL_EXPECT}) — the general capability.
 */

/** Share of pixels (0–1) allowed to differ before a visual check fails. Reliability-first default. */
export const DEFAULT_MAX_DIFF_PIXEL_RATIO = 0.01;

/** Per-pixel color sensitivity (0 strict … 1 lax). Matches Playwright's `toHaveScreenshot` default. */
export const DEFAULT_PIXEL_THRESHOLD = 0.2;

/**
 * Committed-baseline settings applied by the config factory. Playwright's `toHaveScreenshot`
 * already disables animations, hides the caret, waits for fonts, and retries until two consecutive
 * captures match — so those defaults are not repeated; only the tolerance is set here. Baselines
 * are pixel-deterministic only per-platform, so generate/compare them in the Playwright container.
 */
export const VISUAL_EXPECT: PlaywrightTestConfig["expect"] = {
  toHaveScreenshot: {
    maxDiffPixelRatio: DEFAULT_MAX_DIFF_PIXEL_RATIO,
  },
};

/**
 * Where committed baseline screenshots live: per product, then per cell (`{projectName}`), so
 * editions that render differently (e.g. BackWPup Free vs Pro, which run as distinct cells) never
 * share a baseline. Relative to the repo root. The ephemeral generated-spec directory
 * (`.features-gen`) is deliberately NOT part of the path, so baselines survive its regeneration.
 */
export function snapshotPathTemplateFor(product: string): string {
  return `src/projects/${product}/__snapshots__{/projectName}/{arg}{ext}`;
}
