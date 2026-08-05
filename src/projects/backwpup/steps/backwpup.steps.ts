import { expect } from "@playwright/test";

import { Then } from "../fixtures";

/**
 * BackWPup's own step definitions.
 *
 * `Given`/`When`/`Then` come from **this product's** `fixtures.ts`, not from `common/fixtures.ts`, so
 * every step here can destructure a BackWPup page object (`dashboard`, `onboarding`, …) alongside the
 * shared fixtures. playwright-bdd resolves each scenario to the most-extended test instance its steps
 * use, so mixing these with common steps is fine.
 */

// Project-specific step, available only to the BackWPup project.
Then("the BackWPup project marker is present", async ({ page }) => {
  await expect(page.locator("h1")).toContainText("BackWPup");
});

/**
 * Scaffolding check that the page-object fixtures are injectable and their locators resolve.
 *
 * It also pins the wiring itself: because this step destructures page-object fixtures, the generated
 * spec must import BackWPup's extended test instance rather than the shared one. If
 * `src/projects/backwpup/fixtures.ts` ever fell out of the product's `steps` config, generation would
 * fail outright ("Can't guess test instance") instead of silently dropping every page object — which
 * is the quiet failure this guards against.
 */
Then(
  "the BackWPup page objects are wired up",
  async ({ dashboard, onboarding, backupHistory, page }) => {
    // A minimal stand-in for the real screens — enough for each object's locators to resolve, with no
    // WordPress involved, so this stays a @noauth scenario.
    await page.setContent(`<h1>BackWPup</h1>
      <div id="backwup-next-scheduled-backups"></div>
      <table id="backwpup-backup-history"><tbody></tbody></table>
      <div id="backwpup-onboarding-panes"><article data-step="1"></article></div>`);
    await expect(dashboard.jobCards).toHaveCount(0);
    await expect(backupHistory.rows).toHaveCount(0);
    await expect(onboarding.pane(1)).toHaveCount(1);
  },
);
