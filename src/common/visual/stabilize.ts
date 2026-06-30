import type { Page } from "@playwright/test";

/**
 * Page-settling shared by the visual helpers: scroll through the page to trigger lazy-loaded media
 * (then return to the top) and wait for web fonts, so a screenshot is deterministic. Both visual
 * models (committed-baseline and A/B) call this before capturing.
 */

/**
 * Settle `page` for a stable screenshot. Best-effort — a failure here is logged, never thrown, so
 * it cannot mask the comparison that follows.
 *
 * @param lazyLoad - scroll the page to trigger lazy-loaded content (default `true`).
 */
export async function stabilizeForSnapshot(
  page: Page,
  lazyLoad = true,
): Promise<void> {
  try {
    if (lazyLoad) {
      await scrollThroughPage(page);
      // Let lazily-requested assets settle; bounded so a long-polling page can't hang the run.
      await page
        .waitForLoadState("networkidle", { timeout: 5_000 })
        .catch(() => {
          /* networkidle never reached: proceed with whatever has loaded */
        });
      await page.evaluate(() => {
        window.scrollTo(0, 0);
      });
    }
    // Fonts must be loaded or text renders with fallback metrics → spurious diffs.
    await page.evaluate(async () => {
      await document.fonts.ready;
    });
  } catch (error) {
    console.warn(
      `[visual] stabilization skipped (continuing): ${String(error)}`,
    );
  }
}

/** Scroll top→bottom in steps so scroll-triggered lazy loading fires. Capped to stay finite. */
async function scrollThroughPage(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        let y = 0;
        let ticks = 0;
        const timer = setInterval(() => {
          window.scrollBy(0, 400);
          y += 400;
          ticks += 1;
          // Stop at the bottom, or after a hard cap that guards infinite-scroll pages.
          if (y >= document.body.scrollHeight || ticks > 100) {
            clearInterval(timer);
            resolve();
          }
        }, 100);
      }),
  );
}
