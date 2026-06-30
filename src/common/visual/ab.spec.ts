import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import { expectOptimizedToMatchUnoptimized } from "./ab";

// Serve deterministic HTML for both the bypass (`?nowprocket`) and optimized URLs via routing, so
// the A/B helper is exercised end-to-end (navigate both, stabilise, diff) with no WordPress. The
// `body(optimized)` callback chooses the markup per render.
async function routeAbPage(
  page: Page,
  body: (optimized: boolean) => string,
): Promise<void> {
  await page.route(/\/ab-test/, (route) => {
    const optimized = !route.request().url().includes("nowprocket");
    return route.fulfill({ contentType: "text/html", body: body(optimized) });
  });
}

const URL = "http://ab.local/ab-test";

test.describe("expectOptimizedToMatchUnoptimized", () => {
  test("passes when the optimized render matches the unoptimized one", async ({
    page,
  }) => {
    const html = `<body style="margin:0"><div style="width:300px;height:300px;background:teal"></div></body>`;
    await routeAbPage(page, () => html);
    await expectOptimizedToMatchUnoptimized(page, URL);
  });

  test("fails when the optimized render differs (same size, different pixels)", async ({
    page,
  }) => {
    await routeAbPage(
      page,
      (optimized) =>
        `<body style="margin:0"><div style="width:300px;height:300px;background:${optimized ? "red" : "teal"}"></div></body>`,
    );
    await expect(expectOptimizedToMatchUnoptimized(page, URL)).rejects.toThrow(
      /differs from \?nowprocket/,
    );
  });

  test("masking ignores a region that differs between the two renders", async ({
    page,
  }) => {
    await routeAbPage(
      page,
      (optimized) =>
        `<body style="margin:0">` +
        `<div style="width:300px;height:200px;background:teal"></div>` +
        `<div id="dyn" style="width:300px;height:200px;background:${optimized ? "orange" : "purple"}"></div>` +
        `</body>`,
    );
    await expectOptimizedToMatchUnoptimized(page, URL, {
      mask: [page.locator("#dyn")],
    });
  });
});
