import { expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

import { setToggle } from "./toggles";
import { waitForRest } from "../support/rest";
import { expectPanelOpen } from "./panels";

/** A top-level file area the plugin can include in a files backup. */
export type FileArea = "root" | "content" | "plugins" | "themes" | "uploads";

/**
 * Page object for the two data-selection panes: **Select Files** and **Select Tables**.
 *
 * They are one object because they are the two halves of the same question — what goes into the
 * backup — and a scenario configures them as a pair. Each has its own container and its own save
 * (`save_files_exclusions` / `save_excluded_tables`), and those are kept separate here.
 *
 * **The same markup renders under two different roots**, and that is the one thing a caller must know:
 *
 *  - **Onboarding** asks for the blocks by name — `selector-file-db.php` is the only caller that ever
 *    requests `data-content="select-files"` / `"select-tables"` — so each fills its own top-level
 *    sidebar article, `#sidebar-select-files` / `#sidebar-select-tables`.
 *  - **A job card's "Data" link** asks for `settings-data-type` instead (`job-item.php:39`), and *that*
 *    template embeds both parts through `children()` into two panes it keeps behind a type chooser:
 *    `.js-file-settings-section` / `.js-database-settings-section` (`settings-data-type.php:67-73`).
 *
 * On a job screen the `#sidebar-select-files` article still exists but **stays empty forever**:
 * `containers/sidebar.php` globs `parts/sidebar/*` and emits an `<article id="sidebar-{name}">` shell
 * for every part, unsetting `$job_id` before each include, and `select-files.php` returns early
 * without one — only onboarding supplies it, via `$first_job_id`. Addressing that shell is therefore a
 * silent dead end: it resolves, it is never populated, and nothing ever reveals it.
 *
 * So the containers below resolve **by content rather than by position** — each matches whichever root
 * actually holds its own submit control — and one object serves both screens. Verified against
 * BackWPup 5.7.5; `parts/` and `components/` are byte-identical in 5.7.4 and in Pro `9.99.99-c0dd22c2`
 * (the ref `__fixtures__/` was captured from), so this is not version-fragile.
 *
 * The tables side is where the baseline was weakest: it looped `for (i < count) expect(nth(i))` to
 * check "all tables selected". {@link expectAllTablesSelected} replaces that with a single retrying
 * assertion over the *unchecked* subset, so the failure message says how many were wrong rather than
 * stopping at the first.
 */
export class DataSelectionSidebar {
  constructor(private readonly page: Page) {}

  /**
   * One of a pane's two possible roots — whichever is actually populated.
   *
   * `marker` is a control the pane's own template always emits, so the filter drops the empty
   * top-level shell a job screen leaves behind (see the class docstring) without needing to know
   * which screen we are on. Deliberately *not* a visibility filter: the panes start `hidden` behind
   * the chooser, so a visible-only match would resolve to nothing before {@link openFilesPane}.
   */
  private populatedPane(roots: string, marker: string): Locator {
    return this.page.locator(roots).filter({ has: this.page.locator(marker) });
  }

  /**
   * Reveals one of the job-screen chooser's two panes.
   *
   * The gear ("Configure") beside each type in `.js-data-main-setting` swaps the `hidden` class
   * between the chooser and the pane and fires **no request** (`backwpup-job.js:144-150`), so the pane
   * appearing is the only completion signal there is.
   *
   * Scoped to `.js-data-main-setting` deliberately: the pane's own back arrow carries the *same*
   * `data-toggle-setting-panel` value (`navigation-header.php:20`), so an unscoped locator matches two
   * buttons and `.first()` could toggle straight back. Filtering to the visible one also makes this
   * idempotent and a no-op in onboarding, where there is no chooser at all — the pane is the whole
   * sidebar body already.
   */
  private async openPane(which: "files" | "database"): Promise<void> {
    const gear = this.page
      .locator(
        `#sidebar-settings-data-type .js-data-main-setting [data-toggle-setting-panel="${which}"]`,
      )
      .filter({ visible: true });
    if ((await gear.count()) > 0) {
      await gear.first().click();
    }
  }

  // ── Select Files ─────────────────────────────────────────────────────────────

  /** The Select Files pane, under whichever root the current screen renders it. */
  get filesContainer(): Locator {
    return this.populatedPane(
      "#sidebar-select-files, #sidebar-settings-data-type .js-file-settings-section",
      "#file-exclusions-submit",
    );
  }

  /** Reveals the Select Files pane and waits for it. No-op in onboarding — see {@link openPane}. */
  async openFilesPane(): Promise<void> {
    await this.openPane("files");
    await this.waitForFilesLoaded();
  }

  /**
   * Waits for the Select Files pane to be showing with its controls available.
   *
   * {@link filesContainer} only ever resolves to a *populated* root, so what remains to prove is that
   * the pane is actually on screen — neither left `hidden` behind the job screen's chooser nor sitting
   * in an aside that has been parked off-screen. That is what {@link expectPanelOpen} is for.
   */
  async waitForFilesLoaded(): Promise<void> {
    await expectPanelOpen(this.filesContainer);
    await expect(this.fileAreaInput("root")).toBeAttached();
  }

  /**
   * The include-checkbox for one file area.
   *
   * Field names are the plugin's own long-standing option keys (`backuproot`, `backupcontent`, …),
   * which is why the {@link FileArea} union maps onto them here rather than exposing raw names.
   */
  private fileAreaInput(area: FileArea): Locator {
    return this.filesContainer.locator(`[name="backup${area}"]`);
  }

  /** Includes or excludes a whole file area from the backup. Idempotent. */
  async setFileAreaIncluded(area: FileArea, included: boolean): Promise<void> {
    const input = this.fileAreaInput(area);
    // The plugin renders these as sr-only checkboxes with a styled sibling; the enclosing label is
    // the visible proxy (see toggles.ts).
    const proxy = this.filesContainer
      .locator(`label:has([name="backup${area}"])`)
      .first();
    await setToggle(proxy, input, included);
  }

  /** Asserts whether a file area is included. */
  async expectFileAreaIncluded(
    area: FileArea,
    included: boolean,
  ): Promise<void> {
    await expect(this.fileAreaInput(area)).toBeChecked({ checked: included });
  }

  /**
   * Opens the per-area exclusion modal ("Exclude files").
   *
   * All five buttons share the label "Exclude files", so they are told apart by the `data-content`
   * the plugin dispatches on — `exclude-files-core` for the WordPress root, and one per area
   * otherwise. The modal body is fetched, so `getblock` is the barrier.
   */
  async openExclusions(area: FileArea): Promise<void> {
    const content =
      area === "root"
        ? "exclude-files-core"
        : area === "content"
          ? "exclude-files-wp-content"
          : `exclude-files-${area}`;
    await Promise.all([
      waitForRest(this.page, "getblock"),
      this.filesContainer
        .locator(`[data-content="${content}"]`)
        .first()
        .click(),
    ]);
    await expect(this.page.locator(`#sidebar-${content}`)).toBeVisible();
  }

  /** The free-text field listing extra folders to include in the backup. */
  get extraFolders(): Locator {
    return this.filesContainer.locator('[name="dirinclude"]');
  }

  /** The free-text field listing files to exclude from the backup. */
  get excludedFiles(): Locator {
    return this.filesContainer.locator('[name="fileexclude"]');
  }

  /** Saves the file selection. `save_files_exclusions` is the completion signal. */
  async saveFiles(): Promise<void> {
    await Promise.all([
      waitForRest(this.page, "save_files_exclusions"),
      this.filesContainer.locator("#file-exclusions-submit").click(),
    ]);
  }

  // ── Select Tables ────────────────────────────────────────────────────────────

  /** The Select Tables pane, under whichever root the current screen renders it. */
  get tablesContainer(): Locator {
    return this.populatedPane(
      "#sidebar-select-tables, #sidebar-settings-data-type .js-database-settings-section",
      ".js-backwpup-tables-list",
    );
  }

  /**
   * Reveals the Select Tables pane and waits for it. No-op in onboarding — see {@link openPane}.
   *
   * The chooser calls this half "database", not "tables" (`data-settings/buttons.php` is driven by
   * `BackWPup_JobTypes`), which is why the pane's own hook is `.js-database-settings-section`.
   */
  async openTablesPane(): Promise<void> {
    await this.openPane("database");
    await this.waitForTablesLoaded();
  }

  /** Waits for the Select Tables pane to be showing with its table list rendered. */
  async waitForTablesLoaded(): Promise<void> {
    await expectPanelOpen(this.tablesContainer);
    await expect(this.tableList).toBeVisible();
  }

  /** The list the table checkboxes render into. */
  get tableList(): Locator {
    return this.tablesContainer.locator(".js-backwpup-tables-list");
  }

  /** Every table checkbox. */
  get tableCheckboxes(): Locator {
    return this.tableList.locator('[name="tabledb[]"]');
  }

  /** One table's checkbox, by table name. */
  tableCheckbox(table: string): Locator {
    return this.tableList.locator(`[name="tabledb[]"][value="${table}"]`);
  }

  /** Filters the table list by name. */
  async filterTables(query: string): Promise<void> {
    const search = this.tablesContainer.locator('[name="filter_tables"]');
    await search.fill(query);
    await expect(search).toHaveValue(query);
  }

  /**
   * Removes the table filter, restoring the full list.
   *
   * **The control clears the filtering, not the search box** — verified live: after clicking it the
   * full set of tables is listed again while the typed text stays in the field. So the completion
   * signal is the list changing size, not the input emptying (an assertion on the value could never
   * pass). Filtering removes rows from the DOM rather than hiding them, which is why a count is the
   * right measure.
   *
   * Call this only while a filter is actually applied; with no filter the list cannot change and the
   * assertion would rightly fail.
   */
  async clearTableFilter(): Promise<void> {
    const filtered = await this.tableCheckboxes.count();
    await this.tablesContainer
      .locator(".js-backwpup-clear-search")
      .first()
      .click();
    await expect(this.tableCheckboxes).not.toHaveCount(filtered);
  }

  /** Selects or clears every table via the list's select-all control. Idempotent. */
  async setAllTablesSelected(selected: boolean): Promise<void> {
    const input = this.tablesContainer.locator('[name="select_all_tables"]');
    await setToggle(
      this.tablesContainer
        .locator('label:has([name="select_all_tables"])')
        .first(),
      input,
      selected,
    );
  }

  /**
   * Asserts every table is selected — as **one** retrying assertion.
   *
   * Filters to the unchecked checkboxes and requires that set to be empty, so a failure reports how
   * many tables were left out. The baseline's N-iteration loop instead asserted each box in turn,
   * which cost N round-trips and reported only the first mismatch.
   */
  async expectAllTablesSelected(): Promise<void> {
    // `:not(:checked)` is part of the selector, NOT a nested `.locator()` call: nesting it would
    // search the checkboxes' *descendants*, which inputs never have — so the count would be 0 for any
    // input at all and the assertion could never fail.
    await expect(
      this.tableList.locator('[name="tabledb[]"]:not(:checked)'),
    ).toHaveCount(0);
  }

  /** Asserts how many tables the list offers. */
  async expectTableCount(count: number): Promise<void> {
    await expect(this.tableCheckboxes).toHaveCount(count);
  }

  /** Saves the table selection. `save_excluded_tables` is the completion signal. */
  async saveTables(): Promise<void> {
    await Promise.all([
      waitForRest(this.page, "save_excluded_tables"),
      this.tablesContainer.locator("#save-excluded-tables").click(),
    ]);
  }
}
