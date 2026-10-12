import { writeFileSync } from "node:fs";

import { expect } from "@playwright/test";

import { After, Given, Then, When } from "../../fixtures";
import { STOP_FILE_ENV } from "../../config/drain";

/**
 * Steps for the results stream's end-to-end spec (`reporting/results-stream.run.spec.ts`). They touch
 * nothing but the run's own stop file, so the scenarios need no real site.
 */

Given("a background step", () => {
  // Every scenario's Background: a Gherkin step inside the Before hooks.
});

Given("nothing else happens", () => {
  // The scenario's outcome is decided elsewhere, or it passes.
});

Given("the first attempt fails", ({ $testInfo }) => {
  if ($testInfo.retry === 0)
    throw new Error("the first attempt fails on purpose");
});

When("a step fails with {string}", ({ $testInfo }, message: string) => {
  throw new Error(`${message} (attempt ${String($testInfo.retry + 1)})`);
});

Given("the step waits until the run is stopped", async () => {
  await new Promise<never>(() => {
    // Never settles: the spec stops the run while this step is running.
  });
});

Given("the run is asked to stop", () => {
  const stopFile = process.env[STOP_FILE_ENV];
  if (stopFile === undefined) throw new Error(`${STOP_FILE_ENV} is not set`);
  writeFileSync(stopFile, "");
});

Then("the page matches a screenshot that has no baseline", async ({ page }) => {
  await page.setContent("<p>no baseline</p>");
  await expect(page).toHaveScreenshot("never-taken.png");
});

After({ name: "failing After hook", tags: "@failafter" }, () => {
  throw new Error("the After hook fails on purpose");
});
