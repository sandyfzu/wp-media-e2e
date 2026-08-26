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
   * Used after an action that changes the history (a delete, a completed backup), so an assertion
   * reads server state rather than whatever the page rendered before.
   */
  async reload(): Promise<void> {
    await Promise.all([waitForRest(this.page, "backups"), this.page.reload()]);
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
   * The rows for backups that **failed**.
   *
   * Matched on the plugin's own `backwpup-failure-icon`, which it renders only on the failure branch
   * of the row template — not by scanning the row's text for words like "failed", which would also
   * match a filename or a log excerpt that happened to contain them.
   */
  get failedRows(): Locator {
    return this.rows.filter({
      has: this.page.locator(".backwpup-failure-icon"),
    });
  }

  /** Asserts the exact number of backups in the history. */
  async expectRowCount(count: number): Promise<void> {
    await this.waitForLoaded();
    await expect(this.rows).toHaveCount(count);
  }

  /**
   * Asserts no backup in the history failed or was aborted.
   *
   * One retrying assertion over a filtered set, rather than a loop of per-row checks — so it reports
   * "expected 0 failed rows, found 2" instead of failing on whichever row came first.
   */
  async expectNoFailures(): Promise<void> {
    await this.waitForLoaded();
    await expect(this.failedRows).toHaveCount(0);
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

  /** Confirms an open delete-confirmation modal, then waits for the refreshed history. */
  async confirmDelete(): Promise<void> {
    const modal = this.page
      .locator("#sidebar-delete-backup, #sidebar-delete-failed-backup")
      .filter({ visible: true });
    await modal
      .getByRole("button", { name: /^Delete (Backup|Entry)$/ })
      .click();
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

  /**
   * Applies a bulk action to the selected rows.
   *
   * "Apply" ships `disabled` and the plugin enables it once a selection and an action exist, so both
   * are asserted before clicking — a disabled-button click would otherwise pass silently and the
   * scenario would fail later with nothing deleted. `process_bulk_actions` is the completion signal.
   */
  async applyBulkAction(action: "delete"): Promise<void> {
    const select = this.page.locator("#bulk-actions-select");
    await select.selectOption(action);
    const apply = this.page.locator("#bulk-actions-apply");
    await expect(apply).toBeEnabled();
    await Promise.all([
      waitForRest(this.page, "process_bulk_actions"),
      apply.click(),
    ]);
  }
}
