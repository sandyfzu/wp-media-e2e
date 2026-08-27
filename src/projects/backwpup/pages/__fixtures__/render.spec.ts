import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { test, expect } from "@playwright/test";

import { renderFixture } from "./render";

/**
 * Contract for {@link renderFixture} — the helper the locator-contract specs render through.
 *
 * It exists to keep those specs **hermetic**: the captured fixtures are verbatim copies of a real
 * WordPress admin screen, so they reference `s.w.org`, `dropbox.com` and the sanitised
 * `wordpress.test` host. Rendering them with a plain `page.setContent()` waits for `load` — i.e. for
 * every one of those — which made the specs depend on the public internet and time out when it was
 * slow.
 *
 * **The asset here is served by a local server that counts hits and never answers**, which is what
 * makes these tests mean anything. Pointing at an unresolvable host would not: DNS would fail fast,
 * `requestfailed` would fire either way, and the assertions would pass against a helper that does no
 * intercepting at all. A socket that is accepted and then held open reproduces the real failure —
 * the slow third-party asset — and distinguishes "aborted before it left" from "fetched".
 */

/** Requests that actually reached the network. The whole point is that this stays at zero. */
let hits = 0;
let server: Server;
let assetUrl = "";

test.beforeAll(async () => {
  // No response is ever written: the connection is accepted and held, exactly like the slow asset
  // that made `waitUntil: "load"` hang.
  server = createServer(() => {
    hits += 1;
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  assetUrl = `http://127.0.0.1:${String(port)}/tracker.png`;
});

test.afterAll(async () => {
  // The held-open sockets would keep `close()` pending forever without this.
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
});

test.beforeEach(() => {
  hits = 0;
});

/** Markup shaped like a captured fixture: real content plus a third-party asset reference. */
function markup(heading = "Captured"): string {
  return `<main id="root"><h1>${heading}</h1><img src="${assetUrl}" width="8" height="8"><p class="deep">leaf</p></main>`;
}

test.describe("renderFixture", () => {
  test("renders the markup and leaves the DOM queryable", async ({ page }) => {
    await renderFixture(page, markup());

    await expect(page.getByRole("heading", { name: "Captured" })).toBeVisible();
    await expect(page.locator("#root .deep")).toHaveText("leaf");
  });

  test("never lets a subresource request reach the network", async ({
    page,
  }) => {
    // Armed before rendering, because the request is issued while the markup is being parsed.
    // Awaiting the abort's own `requestfailed` is what makes this deterministic: a fixed sleep would
    // only ever prove "nothing arrived *yet*". It also fails correctly in the other direction — a
    // request that is allowed through reaches a server that never answers, so it neither fails nor
    // completes and this wait times out.
    const aborted = page.waitForEvent("requestfailed", {
      predicate: (request) => request.url() === assetUrl,
      timeout: 5_000,
    });

    await renderFixture(page, markup());
    await aborted;

    expect(hits, "a fixture subresource escaped to the network").toBe(0);
  });

  test("resolves promptly even though the asset never responds", async ({
    page,
  }) => {
    // The regression this pins: awaiting `load` against an asset that never answers is what blew the
    // 30s test timeout. Generous bound — the distinction being drawn is "promptly" versus "never".
    const started = Date.now();
    await renderFixture(page, markup());
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  test("can render twice into the same page, second content winning", async ({
    page,
  }) => {
    // The route is registered once per page (a `WeakSet` guard), so a spec rendering two fixtures in
    // one test must still work rather than stacking handlers.
    await renderFixture(page, markup());
    await renderFixture(page, markup("Second"));

    await expect(page.getByRole("heading", { name: "Second" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Captured" })).toHaveCount(
      0,
    );
  });

  test("seals the page to navigation, which is the documented trade", async ({
    page,
  }) => {
    // Not a defect but a consequence worth pinning: the route matches document requests too, so a
    // page rendered through this helper is render-only from then on. A spec that needs to navigate
    // must use a fresh page. If this ever stops being true, the TSDoc saying so should change with it.
    await renderFixture(page, markup());

    await expect(
      page.goto("https://example.com", { timeout: 5_000 }),
    ).rejects.toThrow(/net::ERR_FAILED/);
  });

  test("a page closing mid-flight does not surface a route-callback error", async ({
    browser,
  }) => {
    // Playwright rethrows whatever a route callback throws, rewriting a target-closed error into
    // advice about `unrouteAll`. Closing the page straight after rendering is the teardown race that
    // produces it, so this asserts the helper swallows exactly that and nothing escapes.
    const context = await browser.newContext();
    const page = await context.newPage();

    await renderFixture(page, markup());
    await page.close();
    await context.close();
  });
});
