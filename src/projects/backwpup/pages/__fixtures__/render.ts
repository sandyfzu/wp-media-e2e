import type { Page } from "@playwright/test";

/**
 * Pages already set up to render fixtures, so repeated calls do not stack route handlers.
 *
 * A `WeakSet` because the key is the `Page` itself: entries disappear with the page rather than
 * accumulating for the life of the worker.
 */
const prepared = new WeakSet<Page>();

/**
 * Renders captured markup into `page`, hermetically.
 *
 * **The captures reference the live web.** They are verbatim copies of a real WordPress admin
 * screen, so they carry the emoji `<img>`s WordPress injects from `s.w.org`, plus provider links to
 * `dropbox.com`, `console.developers.google.com` and the sanitised `wordpress.test` host. A plain
 * `page.setContent()` waits for `load`, which waits for **all** of those — so these specs quietly
 * depended on the public internet being reachable and fast, and blew their timeout when it was not.
 *
 * Two changes make them hermetic:
 *
 *  - every request is aborted, so nothing leaves the machine;
 *  - the wait is `domcontentloaded`, which is the honest barrier for a spec that asserts on parsed
 *    DOM and never on a loaded subresource.
 *
 * Layout is unaffected in the ways these specs measure: the blocked resources are decorative images
 * and `<a href>` targets, while the geometry that click assertions need comes from `FIXTURE_STYLES`.
 *
 * **This seals the page to navigation.** The route matches every request, a document request
 * included, so a later `page.goto()` fails with `net::ERR_FAILED` (verified, and pinned by a test in
 * the sibling spec). That is the right trade for a locator-contract spec, which only ever replays
 * markup — but it means a page rendered through this helper is render-only from then on. A spec that
 * needs to navigate should use a fresh page.
 *
 * @param page - the page to render into. Becomes render-only, per above.
 * @param html - the captured fixture, optionally prefixed with `FIXTURE_STYLES`.
 */
export async function renderFixture(page: Page, html: string): Promise<void> {
  if (!prepared.has(page)) {
    await page.route("**/*", async (route) => {
      // Swallowed deliberately, and only this call can fail here. Playwright **rethrows** whatever a
      // route callback throws, and rewrites a target-closed error into advice about `unrouteAll` —
      // so an abort still in flight when the page closes at test teardown would surface as a failure
      // on whichever test is running by then. The request is moot once the page is gone, so there is
      // nothing to report; a helper that does not own the page's lifecycle must not fail on it.
      await route.abort().catch(() => undefined);
    });
    prepared.add(page);
  }
  await page.setContent(html, { waitUntil: "domcontentloaded" });
}
