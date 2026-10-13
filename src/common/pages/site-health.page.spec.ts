import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import { SiteHealthPage, isDirectorySizesRequest } from "./site-health.page";

/**
 * Locator contract for {@link SiteHealthPage}, against wp-admin's markup for the copy button
 * (`site-health-info.php`: a `button.copy-button` whose `data-clipboard-text` holds the text) served
 * through `page.route` — and the directory-sizes request the page fires as it loads, which `goto`
 * must abort.
 */

test.use({ baseURL: "http://wp.test" });

/** The Info tab: the copy button, and a script that asks for directory sizes as the real page does. */
function infoTab(buttons: string, sizesUrl: string): string {
  return `<!doctype html><html><body>
    ${buttons}
    <script>
      window.sizes = "pending";
      fetch(${JSON.stringify(sizesUrl)}).then(
        () => { window.sizes = "served"; },
        () => { window.sizes = "aborted"; });
    </script>
  </body></html>`;
}

const BUTTON = `<button type="button" class="button copy-button" data-clipboard-text="\`&#10;### wp-core ###&#10;&#10;version: 7.1.3&#10;site_url: https://private.example&#10;### wp-paths-sizes (2) ###&#10;wordpress_path: /var/www/private&#13;&#10;version: 9&#10;\`">Copy site info to clipboard</button>`;

/** Serves the Info tab, and would serve directory sizes to any call that got through. */
async function serve(page: Page, body: string): Promise<void> {
  await page.route(/directory-sizes/, (route) =>
    route.fulfill({ contentType: "application/json", body: "{}" }),
  );
  await page.route(/site-health\.php/, (route) =>
    route.fulfill({ contentType: "text/html", body }),
  );
}

test.describe("SiteHealthPage — locator contract", () => {
  test("reads only the asked-for fields from the one button, every section header kept", async ({
    page,
  }) => {
    await serve(
      page,
      infoTab(BUTTON, "/wp-json/wp-site-health/v1/directory-sizes"),
    );
    const siteHealth = new SiteHealthPage(page);
    await siteHealth.goto();
    // A field is its section's: `version` under wp-paths-sizes is not wp-core's.
    expect(await siteHealth.siteInfoFields(["wp-core.version"])).toBe(
      "### wp-core ###\nversion: 7.1.3\n### wp-paths-sizes (2) ###",
    );
  });

  test("returns nothing of the text it was not asked for, so no trace can record it", async ({
    page,
  }) => {
    await serve(page, infoTab(BUTTON, "/x"));
    const siteHealth = new SiteHealthPage(page);
    await siteHealth.goto();
    const kept = await siteHealth.siteInfoFields([
      "wp-core.version",
      "wp-paths-sizes.version",
    ]);
    expect(kept).not.toContain("private");
    expect(kept).toContain("version: 9");
  });

  for (const [form, url] of [
    [
      "pretty permalinks",
      "/wp-json/wp-site-health/v1/directory-sizes?_locale=user",
    ],
    [
      "plain permalinks",
      "/?rest_route=%2Fwp-site-health%2Fv1%2Fdirectory-sizes",
    ],
  ] as const) {
    test(`aborts the page's directory-sizes request under ${form}`, async ({
      page,
    }) => {
      await serve(page, infoTab(BUTTON, url));
      await new SiteHealthPage(page).goto();
      await expect
        .poll(() => page.evaluate(() => window.sizes))
        .toBe("aborted");
    });
  }

  test("fails at once, naming the status, when the page answers an HTTP error", async ({
    page,
  }) => {
    // What WordPress answers a user who may not view Site Health: `wp_die( …, '', 403 )`.
    await page.route(/site-health\.php/, (route) =>
      route.fulfill({ status: 403, contentType: "text/html", body: "Sorry" }),
    );
    const started = Date.now();
    await expect(new SiteHealthPage(page).goto()).rejects.toThrow(
      "[site-health] the Info tab answered HTTP 403",
    );
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  test("fails when the page has no copy button", async ({ page }) => {
    await serve(page, infoTab("", "/x"));
    const siteHealth = new SiteHealthPage(page);
    await siteHealth.goto();
    await expect(
      siteHealth.siteInfoFields(["wp-core.version"], { timeout: 500 }),
    ).rejects.toThrow(/one 'Copy site info to clipboard' button/);
  });

  test("fails when two buttons match, rather than pick one", async ({
    page,
  }) => {
    await serve(page, infoTab(BUTTON + BUTTON, "/x"));
    const siteHealth = new SiteHealthPage(page);
    await siteHealth.goto();
    await expect(
      siteHealth.siteInfoFields(["wp-core.version"], { timeout: 500 }),
    ).rejects.toThrow(/one 'Copy site info to clipboard' button/);
  });

  test("fails when the button holds no text", async ({ page }) => {
    await serve(
      page,
      infoTab(
        '<button type="button" data-clipboard-text=" ">Copy site info to clipboard</button>',
        "/x",
      ),
    );
    const siteHealth = new SiteHealthPage(page);
    await siteHealth.goto();
    await expect(
      siteHealth.siteInfoFields(["wp-core.version"]),
    ).rejects.toThrow(/holds no site info/);
  });
});

test.describe("isDirectorySizesRequest", () => {
  test("matches the route in either permalink form, and nothing else", () => {
    const yes = [
      "https://a.test/wp-json/wp-site-health/v1/directory-sizes",
      "https://a.test/sub/wp-json/wp-site-health/v1/directory-sizes?_locale=user",
      "https://a.test/?rest_route=/wp-site-health/v1/directory-sizes",
    ];
    const no = [
      "https://a.test/wp-json/wp-site-health/v1/tests/background-updates",
      "https://a.test/wp-admin/site-health.php?tab=debug",
      "https://a.test/?rest_route=/wp-site-health/v1/tests/dotorg-communication",
    ];
    for (const url of yes)
      expect(isDirectorySizesRequest(new URL(url))).toBe(true);
    for (const url of no)
      expect(isDirectorySizesRequest(new URL(url))).toBe(false);
  });
});

declare global {
  interface Window {
    /** What the Info tab's directory-sizes call came to. */
    sizes: string;
  }
}
