import { expect } from "@playwright/test";

import { Then } from "../../../common/fixtures";

// Project-specific step, available only to the BackWPup project.
Then("the BackWPup project marker is present", async ({ page }) => {
  await expect(page.locator("h1")).toContainText("BackWPup");
});
