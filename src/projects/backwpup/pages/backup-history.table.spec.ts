import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import { BackupHistoryTable } from "./backup-history.table";

/**
 * How the history table is **read**, as opposed to what its locators resolve to — which
 * `locator-contract.spec.ts` covers against captured markup.
 *
 * Everything here exists because of one property of the live screen: the rows are fetched, and the
 * plugin decides on its own when to fetch them again. A table that was drawn before a backup
 * finished keeps showing the history from before it, for as long as nobody asks the server again.
 * So an assertion made after an action is a statement about the *site* only if the rows behind it
 * were re-fetched, and these cases pin exactly that — including the two ways a reader that skipped
 * it would pass while the site said otherwise.
 *
 * The stand-in below is the plugin's own arrangement reduced to that mechanism: a server render
 * carrying nothing but the loading placeholder, and a script that replaces the whole `tbody` — but
 * only for a listing that reports success, exactly as `refreshBackupTable` does. That condition is
 * what makes the placeholder a barrier rather than decoration, so the stand-in would be worthless
 * without it.
 */

const DASHBOARD_URL = "http://backwpup.test/wp-admin/admin.php?page=backwpup";

// The `thead` is not decoration: it is what keeps the table itself visible on a site whose history
// is empty, which two of the cases below depend on.
const DASHBOARD_HTML = `<!doctype html><html><body>
<table id="backwpup-backup-history">
<thead><tr><th>Created at</th></tr></thead>
<tbody>
  <tr id="backwpup-backup-history-loading"><td>loading</td></tr>
</tbody></table>
<script>
  fetch("/wp-json/backwpup/v1/backups", { method: "POST" })
    .then(function (response) { return response.json(); })
    .then(function (data) {
      if (!data.success) { return; }
      document.querySelector("#backwpup-backup-history tbody").innerHTML =
        data.rows.map(function (id) {
          return '<tr data-backup-id="' + id + '"><td>ok</td></tr>';
        }).join("");
    });
</script>
</body></html>`;

/** The stand-in site's state, mutable so a test can change it behind the rendered page. */
interface FakeSite {
  /** How many archives the site holds. Raising it stands in for a backup landing. */
  stored: number;
  /** The status the listing answers with; 500 stands in for a plugin that cannot serve it. */
  status: number;
  /** How long the listing takes, so a reader can be caught returning before it arrives. */
  delayMs: number;
}

/** Serves the stand-in dashboard and opens it, returning the state the tests drive it with. */
async function serve(page: Page): Promise<FakeSite> {
  const site: FakeSite = { stored: 0, status: 200, delayMs: 0 };
  await page.route("**/backwpup/v1/backups", async (route) => {
    if (site.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, site.delayMs));
    }
    const ok = site.status < 400;
    await route.fulfill({
      status: site.status,
      contentType: "application/json",
      body: JSON.stringify({
        success: ok,
        rows: ok
          ? Array.from({ length: site.stored }, (_, index) => index + 1)
          : [],
      }),
    });
  });
  await page.route("**/wp-admin/admin.php*", async (route) => {
    await route.fulfill({ contentType: "text/html", body: DASHBOARD_HTML });
  });
  await page.goto(DASHBOARD_URL);
  return site;
}

test.describe("BackupHistoryTable — reading the history after it changed", () => {
  /**
   * The premise the rest of the file rests on, and the reason the steps reload.
   *
   * On the live screen the refresh is the plugin's own client-side poll, which runs on its own
   * schedule and only for some of the ways a job can end; here it simply never happens. Either way
   * an assertion left on the rendered table is waiting for something it does not control.
   */
  test("the rendered table does not notice a backup that lands after it was drawn", async ({
    page,
  }) => {
    const site = await serve(page);
    const table = new BackupHistoryTable(page);
    await table.waitForLoaded();
    await expect(table.rows).toHaveCount(0);

    site.stored = 1;
    await expect(
      expect(table.rows).toHaveCount(1, { timeout: 1_000 }),
    ).rejects.toThrow();
  });

  test("reload reads the backup the site gained", async ({ page }) => {
    const site = await serve(page);
    const table = new BackupHistoryTable(page);
    await table.waitForLoaded();

    site.stored = 1;
    await table.reload();
    await table.expectRowCount(1);
  });

  test("reload reads a backup the site lost", async ({ page }) => {
    const site = await serve(page);
    site.stored = 2;
    const table = new BackupHistoryTable(page);
    await table.reload();
    await table.expectRowCount(2);

    site.stored = 1;
    await table.reload();
    await table.expectRowCount(1);
  });

  /**
   * That the wait is over when `reload()` returns, asserted **without** a retrying assertion — a
   * plain count cannot be rescued by waiting, so it fails if the listing is still in flight.
   */
  test("reload waits for the listing rather than leaving the wait to the assertion", async ({
    page,
  }) => {
    const site = await serve(page);
    site.stored = 3;
    site.delayMs = 400;

    const table = new BackupHistoryTable(page);
    await table.reload();
    expect(await table.rows.count()).toBe(3);
  });

  /**
   * The worst way this could fail: a listing the site cannot serve leaves the table holding no
   * backup rows, and no backup rows is exactly what "every backup was deleted" looks like. The
   * placeholder is what stops the two being confused — it stays, so the read fails.
   *
   * This case is also what exposed the barrier this object used to use. Awaiting the listing call
   * around the navigation was observed settling on the *previous* page's response, which is still
   * in flight at that moment — so it reported on a page that no longer existed, and the status it
   * checked was not the one this read depends on.
   */
  test("a listing the site refuses to serve fails the read instead of reading as no backups", async ({
    page,
  }) => {
    const site = await serve(page);
    site.stored = 2;
    site.status = 500;

    const table = new BackupHistoryTable(page);
    await expect(table.reload()).rejects.toThrow(
      /backwpup-backup-history-loading/,
    );
    await expect(table.rows).toHaveCount(0);
  });

  /**
   * Why the failure assertion reloads too, rather than trusting the count step before it: it is a
   * claim about the rows that are there, and a stale table straight after a backup has none.
   */
  test("expectNoFailures passes on an empty table, so it proves nothing unless the rows are fresh", async ({
    page,
  }) => {
    await serve(page);
    const table = new BackupHistoryTable(page);
    await table.waitForLoaded();
    await expect(table.rows).toHaveCount(0);
    await table.expectNoFailures();
  });
});
