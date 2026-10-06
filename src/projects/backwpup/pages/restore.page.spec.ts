import { test, expect } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { FreeRestorePage, ProRestorePage, restorePage } from "./restore.page";
import type { Page } from "@playwright/test";

/**
 * The restore page's locator contract **and** its edition divergence.
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
  // Without the archive's name only the link's shape is held: the dropzone half needs the name.
  test("accepts a deep link carrying restore_file", async ({ page }) => {
    await page.goto(DEEP_LINK);
    await new ProRestorePage(page).expectEntryPath();
  });

  // The URL alone proves nothing on a page that is not the restore screen.
  test("rejects a deep link that did not land on the restore screen", async ({
    page,
  }) => {
    await page.route("**/*", async (route) => {
      await route.fulfill({
        contentType: "text/html",
        body: "<p>Not here</p>",
      });
    });
    await page.goto(DEEP_LINK);
    await expect(new ProRestorePage(page).expectEntryPath()).rejects.toThrow();
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

/**
 * With the archive named, Pro's link is held to that archive: where it is (`file`), where the restore
 * takes it from (`restore_file`), the server told to fetch it (`trigger_download`), and no upload
 * offered — the restore screen's script hides the dropzone on such a link, which the page served
 * here does the same way.
 */
test.describe("Pro's entry path, held to the archive being restored", () => {
  const ARCHIVE = "2026-10-05_13-58-06_DQG3R26702_FILE-DBDUMP-WPPLUGIN.tar";
  const link = (params: Record<string, string>): string =>
    `${BARE}&${new URLSearchParams({ action: "restore-destination_folder", ...params }).toString()}`;
  const FULL = {
    file: `/var/www/site/wp-content/uploads/backwpup/0db8eb/backups/${ARCHIVE}`,
    restore_file: `/var/www/site/wp-content/uploads/backwpup-restore-0123456789abcdef0123/uploads/${ARCHIVE}`,
    jobid: "2",
    service: "folder",
    step: "1",
    trigger_download: "1",
  };
  /** The page as the deep link leaves it: the dropzone hidden by `triggerDownloadByUrlQuery`. */
  const hideDropZone = async (page: Page): Promise<void> => {
    await page.addStyleTag({ content: "#drag-drop-area { display: none; }" });
  };

  test("accepts a link to that archive, fetched by the server, with no upload", async ({
    page,
  }) => {
    await page.goto(link(FULL));
    await hideDropZone(page);
    await new ProRestorePage(page).expectEntryPath(ARCHIVE);
  });

  test("rejects a link to another archive", async ({ page }) => {
    await page.goto(link({ ...FULL, file: "/var/www/site/other.tar" }));
    await hideDropZone(page);
    await expect(
      new ProRestorePage(page).expectEntryPath(ARCHIVE),
    ).rejects.toThrow(/name the archive being restored/);
  });

  test("rejects a restore taken from a copy of another archive", async ({
    page,
  }) => {
    await page.goto(
      link({ ...FULL, restore_file: "/var/www/x/uploads/other.tar" }),
    );
    await hideDropZone(page);
    await expect(
      new ProRestorePage(page).expectEntryPath(ARCHIVE),
    ).rejects.toThrow(/copy of that same archive/);
  });

  test("rejects a link that does not have the server fetch it", async ({
    page,
  }) => {
    const { trigger_download: _ignored, ...rest } = FULL;
    await page.goto(link(rest));
    await hideDropZone(page);
    await expect(
      new ProRestorePage(page).expectEntryPath(ARCHIVE),
    ).rejects.toThrow(/server fetch the archive itself/);
  });

  test("rejects a screen that offers an upload after all", async ({ page }) => {
    await page.goto(link(FULL));
    await expect(
      new ProRestorePage(page).expectEntryPath(ARCHIVE),
    ).rejects.toThrow(/never asks the user for a file/);
  });
});

test.describe("Free's entry path — forced re-upload", () => {
  test("accepts the bare page and requires the upload control", async ({
    page,
  }) => {
    await page.goto(BARE);
    await new FreeRestorePage(page).expectEntryPath();
  });

  test("rejects a bare page that offers no upload", async ({ page }) => {
    await page.goto(BARE);
    await page.addStyleTag({ content: "#drag-drop-area { display: none; }" });
    await expect(new FreeRestorePage(page).expectEntryPath()).rejects.toThrow();
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

/**
 * The upload starts by itself once a file is set, and plupload writes its progress into the readout —
 * empty, and so not visible, until it does. A script stands in for plupload here.
 */
test.describe("FreeRestorePage.uploadArchive", () => {
  test("sets the file and sees the upload start", async ({
    page,
  }, testInfo) => {
    const archive = testInfo.outputPath("backup.tar");
    writeFileSync(archive, "tar");
    await page.goto(BARE);
    await page.evaluate(() => {
      document
        .querySelector('input[type="file"]')
        ?.addEventListener("change", () => {
          const progress = document.querySelector("#upload_progress");
          if (progress !== null) progress.textContent = "Uploading 1%";
        });
    });
    await new FreeRestorePage(page).uploadArchive(archive);
  });

  test("fails when the upload never starts", async ({ page }, testInfo) => {
    const archive = testInfo.outputPath("backup.tar");
    writeFileSync(archive, "tar");
    await page.goto(BARE);
    await expect(
      new FreeRestorePage(page).uploadArchive(archive),
    ).rejects.toThrow();
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
