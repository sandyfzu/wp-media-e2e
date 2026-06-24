import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { expect, test as setup } from "@playwright/test";

import { getPool, readRouting } from "../config/metadata";
import { isPlaceholderSite } from "../config/sites";

/**
 * Authentication setup project (plain Playwright, not BDD). For each real site in the
 * cell's pool it logs in once through the WordPress UI and saves the session to that
 * site's `storageState` file, which the BDD project reuses (one site per worker — see
 * fixtures.ts). The BDD project declares this as a `dependency`, so it always runs first.
 *
 * Logins run in isolated browser contexts, so saved sessions never bleed across sites.
 * When the pool holds only placeholder/example sites (no sites.json yet), the whole
 * setup is skipped so the scaffold's `@noauth` smoke tests stay green on a fresh checkout.
 */
setup("authenticate site pool", async ({ browser }, testInfo) => {
  const { product, cell } = readRouting(testInfo.project.metadata);
  const real = getPool(product, cell).filter(
    (site) => !isPlaceholderSite(site),
  );
  setup.skip(
    real.length === 0,
    `No real sites configured for "${product}/${cell}" (placeholder example data ` +
      "in use). Create sites.json for real runs.",
  );

  for (const site of real) {
    const context = await browser.newContext({ baseURL: site.baseURL });
    try {
      const page = await context.newPage();
      await page.goto("/wp-login.php");
      await page.getByLabel("Username or Email Address").fill(site.username);
      await page.getByLabel("Password", { exact: true }).fill(site.password);
      await page.getByRole("button", { name: "Log In" }).click();

      // After login WordPress lands on the dashboard or, periodically, the
      // "Administration email verification" interstitial. The Log In click waits for
      // that navigation, so the URL here is settled — dismiss the interstitial if shown.
      if (page.url().includes("action=confirm_admin_email")) {
        await page.getByRole("link", { name: /remind me later/i }).click();
      }
      await expect(page).toHaveURL(/\/wp-admin\/?/);

      await mkdir(dirname(site.storageState), { recursive: true });
      await context.storageState({ path: site.storageState });
    } finally {
      await context.close();
    }
  }
});
