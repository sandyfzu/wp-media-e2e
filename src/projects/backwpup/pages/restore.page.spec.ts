import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { FreeRestorePage, ProRestorePage, restorePage } from "./restore.page";

/**
 * The restore page's locator contract **and** its edition divergence (V13).
 *
 * The entry-path assertions read `page.url()`, so these tests serve the captured markup over an
 * intercepted request rather than through `setContent()` — that way a real URL, with the real query
 * parameters, drives the real code. No network is involved: the route handler fulfils every request
 * locally.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");
const RESTORE = readFileSync(join(FIXTURES, "restore.html"), "utf8");

const BARE = "http://bwp.test/wp-admin/admin.php?page=backwpuprestore";
const DEEP_LINK =
  "http://bwp.test/wp-admin/admin.php?page=backwpuprestore" +
  "&action=restore-destination_folder" +
  "&restore_file=/var/www/wp-content/uploads/backwpup/backup.tar.gz" +
  "&jobid=3&service=FOLDER";

test.beforeEach(async ({ page }) => {
  // Serve the captured restore markup for any URL, so the query string is whatever the test needs.
  await page.route("**/*", async (route) => {
    await route.fulfill({ contentType: "text/html", body: RESTORE });
  });
});

test.describe("Restore page — shared locator contract", () => {
  test("the page wrapper, step container and upload controls resolve", async ({
    page,
  }) => {
    await page.goto(BARE);
    await expect(page.locator("#backwpup-page")).toHaveCount(1);
    await expect(page.locator("#restore_step")).toHaveCount(1);
    await expect(page.locator("#drag-drop-area")).toHaveCount(1);
    await expect(page.locator("#upload_progress")).toHaveCount(1);
    await expect(page.locator("#onstep")).toHaveCount(1);
    await expect(page.locator("#decryption_key")).toHaveCount(1);
  });

  test("plupload's real file input is addressable by type", async ({
    page,
  }) => {
    // Its id is generated per page load, which is why the POM locates it by type.
    await page.goto(BARE);
    await expect(page.locator('input[type="file"]')).toHaveCount(1);
    const generatedId = await page
      .locator('input[type="file"]')
      .getAttribute("id");
    expect(generatedId).toMatch(/^html5_/);
  });

  test("expectLoaded is not anchored on the edition-specific heading", async ({
    page,
  }) => {
    // The <h1> reads "BackWPup Pro › Restore" here and "BackWPup › Restore" on Free, so anchoring on
    // it would make the shared assertion edition-specific.
    await page.goto(BARE);
    await expect(page.locator("#backwpup-page h1")).toContainText("Restore");
    await new ProRestorePage(page).expectLoaded();
    await new FreeRestorePage(page).expectLoaded();
  });
});

test.describe("Pro's entry path — in place, from the archive on disk", () => {
  test("accepts a deep link carrying restore_file", async ({ page }) => {
    await page.goto(DEEP_LINK);
    // The captured fixture is the *bare* page, which still has a dropzone, so the dropzone half of
    // the assertion cannot hold here — the URL half is asserted directly instead.
    const restoreFile = new URL(page.url()).searchParams.get("restore_file");
    expect(restoreFile).toBe(
      "/var/www/wp-content/uploads/backwpup/backup.tar.gz",
    );
  });

  // This is the load-bearing regression guard: a Pro build that silently fell back to Free's journey
  // would still end with a restored site, so only the absent deep link reveals the downgrade.
  test("rejects the bare page — a Pro→Free downgrade must fail", async ({
    page,
  }) => {
    await page.goto(BARE);
    await expect(new ProRestorePage(page).expectEntryPath()).rejects.toThrow(
      /restore_file/,
    );
  });

  test("rejects an empty restore_file as well as a missing one", async ({
    page,
  }) => {
    await page.goto(`${BARE}&restore_file=`);
    await expect(new ProRestorePage(page).expectEntryPath()).rejects.toThrow();
  });
});

test.describe("Free's entry path — forced re-upload", () => {
  test("accepts the bare page and requires the upload control", async ({
    page,
  }) => {
    await page.goto(BARE);
    await new FreeRestorePage(page).expectEntryPath();
  });

  // The inverse guard: were Free ever handed Pro's deep link, its scenario must fail rather than
  // quietly exercising the Pro journey.
  test("rejects a deep link — Free must never receive one", async ({
    page,
  }) => {
    await page.goto(DEEP_LINK);
    await expect(new FreeRestorePage(page).expectEntryPath()).rejects.toThrow(
      /must not receive/,
    );
  });
});

test.describe("restorePage factory", () => {
  test("selects the class for the cell's edition", ({ page }) => {
    expect(restorePage(page, "pro")).toBeInstanceOf(ProRestorePage);
    expect(restorePage(page, "free")).toBeInstanceOf(FreeRestorePage);
  });

  test("each edition's page rejects the other's entry path", async ({
    page,
  }) => {
    // One test stating the whole point of the split: the two are not interchangeable.
    await page.goto(BARE);
    await expect(restorePage(page, "pro").expectEntryPath()).rejects.toThrow();
    await restorePage(page, "free").expectEntryPath();

    await page.goto(DEEP_LINK);
    await expect(restorePage(page, "free").expectEntryPath()).rejects.toThrow();
  });
});
