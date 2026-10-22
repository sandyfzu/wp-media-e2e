import { expect } from "@playwright/test";
import type { Route } from "@playwright/test";

import { Given, Then } from "../../fixtures";

/**
 * Steps for the lost-requests end-to-end spec (`reporting/page-loads.run.spec.ts`). The site's own
 * origin is served from `page.route`: a dashboard whose script is lost in transport, as an HTTP/3
 * connection drop loses it, plus a third-party asset lost too, which must not be reported.
 */

Given(
  "the site's dashboard loads without its own script",
  async ({ page, baseURL }) => {
    const origin = new URL(baseURL ?? "").origin;
    await page.route("**/*", async (route: Route) => {
      const url = new URL(route.request().url());
      if (url.origin === origin && url.pathname === "/wp-admin/admin.php") {
        return route.fulfill({
          contentType: "text/html",
          body:
            '<script src="/wp-content/plugins/demo/admin.js?ver=1"></script>' +
            '<link rel="stylesheet" href="https://cdn.other.test/x.css">' +
            "<main>dashboard</main>",
        });
      }
      return route.abort("connectionclosed");
    });
    await page.goto("/wp-admin/admin.php?page=demo&_wpnonce=0123456789");
  },
);

Then("the dashboard shows what its script renders", async ({ page }) => {
  // The lost script would have rendered it; a short wait keeps the spec quick.
  await expect(page.locator("#rendered-by-script")).toBeVisible({
    timeout: 1_000,
  });
});
