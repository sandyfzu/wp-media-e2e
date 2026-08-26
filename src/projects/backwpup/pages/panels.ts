import { expect } from "@playwright/test";
import type { Locator } from "@playwright/test";

/**
 * The one assertion primitive for "a BackWPup **sidebar** panel is open".
 *
 * **`toBeVisible()` alone is a false pass here, and that is not a style opinion.** BackWPup's two panel
 * containers close by different mechanisms:
 *
 *  - `closeModal()` sets `hidden` on `#backwpup-modal` (`backwpup-admin.js:702-706`) — a real
 *    `display: none`, so every panel inside is genuinely invisible. `toBeVisible()` is correct there.
 *  - `closeSidebar()` only *parks* the aside: it adds `translate-x-[450px]` to `#backwpup-sidebar`
 *    (`:466-469`) and leaves the articles alone. A transformed element keeps its bounding box, so the
 *    panel that was last shown keeps reporting **visible** forever, off-screen and unclickable.
 *
 * Verified live against BackWPup Pro 5.7.5 (viewport 1280 wide) — open, then close, then re-measure
 * `#sidebar-frequency`:
 *
 * ```
 * after open   visible=true  inViewport=true   x=910
 * after close  visible=true  inViewport=false  x=1344   ← still "visible"
 * ```
 *
 * The consequence is a scenario that closes one sidebar and asserts another has opened: it passes
 * instantly against the stale panel and then fails several steps later on a click, with
 * "element is outside of the viewport" pointing at the wrong place entirely. That is exactly how this
 * was found, while driving the fixture-capture script.
 *
 * **Both assertions are kept deliberately.** `openSidebar()` hides every article before showing the
 * requested one (`:456-464`), so `toBeVisible()` is what catches "a different panel is the one on
 * show"; `toBeInViewport()` is what catches the parked aside. In-viewport alone would technically cover
 * both — a `display: none` element has no box — but it reports the wrong reason for the first case.
 *
 * **Why not `toBeInViewport({ ratio: 1 })`:** a long provider form (S3's, for one) is taller than the
 * viewport, so demanding full containment could never pass. Any intersection is the honest signal that
 * the aside is no longer parked, and Playwright's own click actionability waits out the 500ms
 * `transition-transform` from there.
 *
 * Every reveal path funnels through `openSidebar()` — the dashboard's `load_and_open_sidebar`, the
 * storage picker's `load_and_open_storage`, and onboarding's delegated tile handler (`:1892-1895`,
 * which fires no request but still un-parks the aside) — so this holds on both screens.
 *
 * @param panel - the `#sidebar-<name>` article, or a pane nested inside one.
 * @param options.timeout - budget for each assertion, in ms.
 */
export async function expectPanelOpen(
  panel: Locator,
  options: { timeout?: number } = {},
): Promise<void> {
  const budget =
    options.timeout === undefined ? {} : { timeout: options.timeout };
  await expect(panel).toBeVisible(budget);
  await expect(panel).toBeInViewport(budget);
}

/**
 * Asserts a sidebar panel has been dismissed.
 *
 * The mirror of {@link expectPanelOpen}: **not** `toBeHidden()`, which could never pass, because
 * closing parks the aside rather than hiding it. Leaving the viewport is the observable outcome.
 */
export async function expectPanelClosed(
  panel: Locator,
  options: { timeout?: number } = {},
): Promise<void> {
  const budget =
    options.timeout === undefined ? {} : { timeout: options.timeout };
  await expect(panel).not.toBeInViewport(budget);
}
