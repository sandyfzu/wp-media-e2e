import { expect } from "@playwright/test";
import type { Download, Locator, Page } from "@playwright/test";

import { setToggle } from "./toggles";
import { waitForRest } from "../support/rest";

/**
 * A per-row action in the history table's menu, by its visible label.
 *
 * "Restore" is deliberately absent: the plugin labels that action from the backup record itself
 * (`dataset-restore['label']`), so its text is data-driven and it is located by the modal it opens
 * instead — see {@link BackupHistoryTable.openRestore}.
 */
export type BackupRowAction = "View log" | "Download" | "Delete";

/**
 * Page object for the **Backups History** table.
 *
 * Rendered identically on the dashboard (`page=backwpup`) and the dedicated Backups screen
 * (`page=backwpupbackups`) — both emit `table#backwpup-backup-history` — so one object serves both.
 *
 * Two properties of this table drive the whole design:
 *
 *  1. **The rows are loaded asynchronously.** The table ships with a single placeholder row,
 *     `tr#backwpup-backup-history-loading`, and the real rows arrive from the `backups` REST call. So
 *     any count assertion made before the load lands reads zero and *passes* for the wrong reason —
 *     which is why {@link waitForLoaded} exists and why every counting helper goes through it.
 *  2. **Every row is keyed by `data-backup-id`.** That replaces the baseline's `td:nth-child(n)`
 *     positional scraping and its `<td>`-counting layout sniff outright: rows are addressed by the
 *     plugin's own identifier, and the columns are never counted. This matters because the row's
 *     column *layout changes* for a failed backup — the fifth column becomes "Status" instead of
 *     "Data" — so any positional assumption is wrong for exactly the rows a test most wants to check.
 */
export class BackupHistoryTable {
  private readonly root: Locator;

  /**
   * @param page - the page showing a history table.
   * @param root - override the table locator; defaults to the plugin's own table id, which is the
   * same on both screens that render it.
   */
  constructor(
    private readonly page: Page,
    root?: Locator,
  ) {
    this.root = root ?? page.locator("#backwpup-backup-history");
  }

  /**
   * Waits until the history has finished loading.
   *
   * The placeholder row disappearing is the signal, because it is what the plugin itself replaces
   * when the data arrives — and unlike the `backups` REST barrier it also works on a page that
   * already loaded before this object was constructed.
   */
  async waitForLoaded(): Promise<void> {
    await expect(this.root).toBeVisible();
    await expect(
      this.page.locator("#backwpup-backup-history-loading"),
    ).toHaveCount(0);
  }

  /**
   * Reloads the history from the server and waits for the new data.
   *
   * **The only way to read this table after something changed it.** The plugin refreshes it from a
   * client-side poll of its own, on its own schedule, and only for some of the ways a backup can
   * end — so the rows on screen are not a statement about the site until they have been fetched
   * again. Every assertion made after an action goes through this first.
   *
   * The navigation and {@link waitForLoaded} are the whole barrier, and together they are exact.
   * The reload resolving means the new document has loaded; the server always renders the
   * placeholder row into it; and nothing removes that row except the plugin replacing the entire
   * `tbody` with the rows it fetched. So the row being gone means the listing arrived and
   * rendered — and a listing that failed leaves it in place, which fails here instead of reading
   * as a history that emptied itself.
   *
   * **Awaiting the `backups` call instead would not be sound**, which is why it is not done: the
   * listing is requested on document-ready, so a barrier armed after the navigation can miss it,
   * and one armed before it is satisfied just as happily by the *previous* page's request, which
   * is usually still in flight. That barrier reports the wrong page and proves nothing about this
   * one.
   *
   * @throws {@link Error} if the history never finishes loading — the listing failed, or the
   * screen does not carry one.
   */
  async reload(): Promise<void> {
    await this.page.reload();
    await this.waitForLoaded();
  }

  /** Every backup row. Only rows with a real backup id — the placeholder is excluded by construction. */
  get rows(): Locator {
    return this.root.locator("tbody tr[data-backup-id]");
  }

  /** The newest backup's row (the plugin renders newest first). */
  get newestRow(): Locator {
    return this.rows.first();
  }

  /** One backup's row, by the plugin's backup id. */
  row(backupId: string | number): Locator {
    return this.root.locator(`tbody tr[data-backup-id="${String(backupId)}"]`);
  }

  /**
   * The rows for backups that produced **no usable archive** — failed or aborted.
   *
   * Matched on the delete control the row template offers *only* on that branch: a failed or aborted
   * row's delete opens `delete-failed-backup`, which no other row emits under any viewport
   * (`components/table-row-backups.php`, where both statuses take the same branch). That is the
   * plugin's own JS contract hook, so it is stable by construction — and it is not text matching,
   * which would also hit a filename or a log excerpt containing the word "failed".
   *
   * One narrower condition than the status cell's: the control is guarded on the row also carrying a
   * real backup id, while the failure *styling* is not. A failed row with an id of `0` would render
   * as failed and be invisible here — unreachable in practice, since the id is the backups table's
   * own primary key, but the gap is the locator's and not the template's.
   *
   * **Deliberately not `.backwpup-failure-icon`.** The template puts that class on the icon only
   * when the status is `failed`; an **aborted** backup gets `text-alert` instead and would slip
   * through — the exact rows a scenario asserting "nothing went wrong" most needs to catch.
   */
  get failedRows(): Locator {
    return this.rows.filter({
      has: this.page.locator('[data-content="delete-failed-backup"]'),
    });
  }

  /**
   * The {@link failedRows} for runs a user **aborted**, rather than ones that failed on their own.
   *
   * The template gives both the same row and tells them apart only in the status it prints —
   * "Aborted by user" against "<destination> backup failed – <reason>" — and in a colour class, which
   * is styling rather than a contract. The message is what a user reads, so it is what this matches,
   * and only inside a row the plugin's own hook has already marked unsuccessful.
   */
  get abortedRows(): Locator {
    return this.failedRows.filter({ hasText: "Aborted by user" });
  }

  /**
   * Asserts the exact number of backups in the history **as currently rendered**.
   *
   * It makes no claim about how fresh that is: establishing freshness is the caller's job, through
   * {@link reload}, because only the caller knows whether anything has changed the history since
   * the page was rendered. Keeping the two apart is what lets this be asserted against captured
   * markup as well as against a live site.
   *
   * Nor does it see past the **first page**: the listing is paged ten rows at a time, client and
   * server agreeing on that default, so a site holding more renders ten whatever the total is.
   * Every scenario starts from a freshly installed plugin and counts in single digits, which is
   * well inside it — a caller that could exceed ten needs a different question, not a larger
   * number here.
   */
  async expectRowCount(count: number): Promise<void> {
    await this.waitForLoaded();
    await expect(this.rows, "rows the history table renders").toHaveCount(
      count,
    );
  }

  /**
   * Asserts no backup in the history failed or was aborted, **as currently rendered**.
   *
   * One retrying assertion over a filtered set, rather than a loop of per-row checks — so it reports
   * "expected 0 failed rows, found 2" instead of failing on whichever row came first.
   *
   * Freshness is the caller's job here too, and it matters more than it does for a count: this
   * passes trivially on a table that renders no rows, so a caller asserting it after an action that
   * changed the history must {@link reload} first or it proves nothing.
   */
  async expectNoFailures(): Promise<void> {
    await this.waitForLoaded();
    await expect(
      this.failedRows,
      "history rows for backups that failed or were aborted",
    ).toHaveCount(0);
  }

  // ── Per-row actions ──────────────────────────────────────────────────────────

  /**
   * Opens a row's action menu.
   *
   * The actions render twice — a dots menu for wide viewports (`js-backwpup-menu`) and a flat list
   * for narrow ones — so the visible one is chosen at run time and `@mobile` needs no special case.
   * On narrow viewports there is no menu to open and this is a no-op.
   */
  private async openActions(row: Locator): Promise<void> {
    const menu = row.locator(".js-backwpup-menu").filter({ visible: true });
    if ((await menu.count()) > 0) {
      await menu.first().click();
      await expect(
        row.locator(".js-backwpup-menu-content").filter({ visible: true }),
      ).toBeVisible();
    }
  }

  /** A named action within a row, wherever the current viewport renders it. */
  private action(row: Locator, name: BackupRowAction): Locator {
    return row.getByRole("button", { name }).filter({ visible: true }).first();
  }

  /**
   * Clicks "View log" for a row and waits for the log modal to show.
   *
   * The modal's body is fetched, so the `getblock` call is the barrier — the modal element itself
   * pre-exists in the DOM and would satisfy a visibility check before its content arrived.
   */
  async viewLog(row: Locator): Promise<void> {
    await this.openActions(row);
    await Promise.all([
      waitForRest(this.page, "getblock"),
      this.action(row, "View log").click(),
    ]);
    await expect(this.page.locator("#sidebar-backup-log")).toBeVisible();
  }

  /**
   * Downloads a row's archive and returns Playwright's {@link Download}.
   *
   * Returned rather than saved here, so the scenario decides where it lands — which keeps downloads
   * inside the test's own `outputDir` instead of a shared directory in the repo.
   */
  async download(row: Locator): Promise<Download> {
    await this.openActions(row);
    const [download] = await Promise.all([
      this.page.waitForEvent("download"),
      this.action(row, "Download").click(),
    ]);
    return download;
  }

  /**
   * Opens the delete-confirmation modal for a row.
   *
   * Deliberately stops at the confirmation: deleting is destructive and irreversible, so arming it
   * and confirming it are separate calls. {@link confirmDelete} completes the flow.
   */
  async openDelete(row: Locator): Promise<void> {
    await this.openActions(row);
    await this.action(row, "Delete").click();
    await expect(
      this.page
        .locator("#sidebar-delete-backup, #sidebar-delete-failed-backup")
        .filter({ visible: true }),
    ).toBeVisible();
  }

  /**
   * Confirms an open delete-confirmation modal and waits for the page it navigates to.
   *
   * **This one navigates; its bulk sibling does not.** The per-row confirm button is rendered with
   * the plugin's `open-url` trigger, whose handler is a bare `window.location = data-href`
   * (`assets/js/backwpup-admin.js`) — there is no REST call to await, and the history is rebuilt by
   * the server on the way back. Waiting on the main frame's navigation response is therefore the
   * only honest barrier: `waitForLoaded()` alone would race the old page, and the loading marker it
   * looks for is emitted only by the initial server render, so it can also be satisfied instantly by
   * a page that is about to be replaced.
   */
  async confirmDelete(): Promise<void> {
    const modal = this.page
      .locator("#sidebar-delete-backup, #sidebar-delete-failed-backup")
      .filter({ visible: true });
    await Promise.all([
      this.page.waitForResponse(
        (response) =>
          response.request().isNavigationRequest() &&
          response.request().frame() === this.page.mainFrame(),
      ),
      modal.getByRole("button", { name: /^Delete (Backup|Entry)$/ }).click(),
    ]);
    await this.waitForLoaded();
  }

  /**
   * Opens the **Restore** modal from a row.
   *
   * The row's Restore action is labelled by the plugin from the backup record itself
   * (`dataset-restore['label']`), so its text is data-driven and cannot be hard-coded here; the
   * action is found by the modal it opens instead. Whether it then deep-links at the on-disk archive
   * or lands on the bare restore page is the edition divergence — `RestorePage` owns that.
   */
  async openRestore(row: Locator): Promise<void> {
    await this.openActions(row);
    await row
      .locator('[data-content="restore-backup"]')
      .filter({ visible: true })
      .first()
      .click();
    await expect(this.page.locator("#sidebar-restore-backup")).toBeVisible();
  }

  // ── Selection & bulk actions ─────────────────────────────────────────────────

  /** Selects or clears one row's checkbox. Idempotent. */
  async setRowSelected(row: Locator, selected: boolean): Promise<void> {
    const input = row.locator(".js-backwpup-select-backup");
    // The checkbox is `sr-only`; its visible proxy is the styled sibling inside the same label.
    await setToggle(row.locator("label").first(), input, selected);
  }

  /** Selects or clears every row via the header's select-all checkbox. Idempotent. */
  async setAllSelected(selected: boolean): Promise<void> {
    const input = this.root.locator(".js-backwpup-select-all");
    await setToggle(this.root.locator("thead label").first(), input, selected);
  }

  /** The confirmation the bulk **delete** opens before anything is removed. */
  get bulkDeleteModal(): Locator {
    return this.page.locator("#sidebar-bulk-delete-backups");
  }

  /**
   * Chooses a bulk action and presses Apply, stopping at its confirmation.
   *
   * "Apply" ships `disabled` and the plugin enables it only once a selection **and** the `delete`
   * action both exist, so it is asserted enabled before clicking — a disabled-button click would
   * otherwise pass silently and the scenario would fail later with nothing deleted.
   *
   * **Apply does not delete anything, and that is the plugin's design, not a quirk of this object.**
   * Its handler stores the selection and opens `#sidebar-bulk-delete-backups`, returning without
   * issuing a request at all (`assets/js/backwpup-admin.js`, the `action === 'delete'` branch); the
   * REST call happens only when that dialog is confirmed. So the modal appearing is the honest
   * completion signal here, and {@link confirmBulkDelete} owns the rest — the same arm-then-confirm
   * split the per-row delete uses, for the same reason.
   */
  async applyBulkAction(action: "delete"): Promise<void> {
    const select = this.page.locator("#bulk-actions-select");
    await select.selectOption(action);
    const apply = this.page.locator("#bulk-actions-apply");
    await expect(apply).toBeEnabled();
    await apply.click();
    await expect(this.bulkDeleteModal).toBeVisible();
  }

  /**
   * Confirms an armed bulk delete, then waits for the refreshed history.
   *
   * `process_bulk_actions` is the completion signal — this is where the plugin finally issues it —
   * and the reload afterwards is what makes the following assertions read server state rather than
   * the rows that were on screen before.
   */
  async confirmBulkDelete(): Promise<void> {
    await Promise.all([
      waitForRest(this.page, "process_bulk_actions"),
      this.bulkDeleteModal
        .getByRole("button", { name: "Delete Backups" })
        .click(),
    ]);
    await this.reload();
  }
}
