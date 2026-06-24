import { expect } from "@playwright/test";

import { Given, Then } from "../fixtures";

/**
 * Generic, product-agnostic step definitions shared by every project. Each step's
 * Gherkin pattern is its contract; the feature files are the usage documentation.
 */

Given("a page titled {string}", async ({ page }, title: string) => {
  await page.setContent(
    `<!doctype html><title>${title}</title><h1>${title}</h1>`,
  );
});

Then("the page title is {string}", async ({ page }, title: string) => {
  await expect(page).toHaveTitle(title);
});

Then("the heading mentions {string}", async ({ page }, text: string) => {
  await expect(page.getByRole("heading")).toContainText(text);
});
