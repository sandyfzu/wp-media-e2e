import { expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

import { setToggle } from "./toggles";
import { waitForRest } from "../support/rest";
import { expectPanelClosed, expectPanelOpen } from "./panels";
import { FILE_AREAS, fileAreaOption } from "../support/job-options";
import type { FileArea } from "../support/job-options";

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
   * shared with the job-option reader so the UI and the stored state cannot name them differently.
   */
  private fileAreaInput(area: FileArea): Locator {
    return this.filesContainer.locator(`[name="${fileAreaOption(area)}"]`);
  }

  /** Includes or excludes a whole file area from the backup. Idempotent. */
  async setFileAreaIncluded(area: FileArea, included: boolean): Promise<void> {
    const input = this.fileAreaInput(area);
    // The plugin renders these as sr-only checkboxes with a styled sibling; the enclosing label is
    // the visible proxy (see toggles.ts).
    const proxy = this.filesContainer
      .locator(`label:has([name="${fileAreaOption(area)}"])`)
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
   * Asserts every file area is included — as **one** retrying assertion.
   *
   * Filters the five areas' checkboxes to the unchecked ones and requires that set to be empty, so
   * a failure reports how many areas were left out instead of stopping at the first. The mirror of
   * {@link expectAllTablesSelected}, and the same reason: five sequential assertions cost five
   * round-trips and hide the second failure behind the first.
   *
   * **The count of areas is asserted first, and that half is not decoration.** "No unchecked box"
   * is also true of a pane holding no boxes at all, so on its own it would pass against a panel
   * that failed to render — the one outcome this assertion most needs to catch.
   *
   * @param options.timeout - budget for each assertion, in ms.
   */
  async expectAllFileAreasIncluded(
    options: { timeout?: number } = {},
  ): Promise<void> {
    const budget =
      options.timeout === undefined ? {} : { timeout: options.timeout };
    const areas = (suffix: string): string =>
      FILE_AREAS.map(
        (area) => `[name="${fileAreaOption(area)}"]${suffix}`,
      ).join(", ");
    await expect(this.filesContainer.locator(areas(""))).toHaveCount(
      FILE_AREAS.length,
      budget,
    );
    await expect(
      this.filesContainer.locator(areas(":not(:checked)")),
    ).toHaveCount(0, budget);
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

  /** Includes or excludes one table from the database dump. Idempotent. */
  async setTableIncluded(table: string, included: boolean): Promise<void> {
    // Same shape as every other switch here: an sr-only input inside a visible label (toggles.ts).
    const proxy = this.tableList
      .locator(`label:has([name="tabledb[]"][value="${table}"])`)
      .first();
    await setToggle(proxy, this.tableCheckbox(table), included);
  }

  /** Asserts whether one table is included in the dump. */
  async expectTableIncluded(table: string, included: boolean): Promise<void> {
    await expect(this.tableCheckbox(table)).toBeChecked({ checked: included });
  }

  /**
   * Asserts the selection a **new** job starts with: every table of this WordPress install is in,
   * and any other table sharing the database is out.
   *
   * That is the plugin's actual rule, not "everything is ticked" — `select-tables.php` ticks a
   * table only if its name *contains* `$wpdb->prefix`, so a database shared with another
   * application legitimately starts with the foreign tables unticked. Asserting the blunt version
   * would pass only by accident on a database that happens to hold nothing else.
   *
   * **Contains, not starts-with, and the difference is the plugin's own.** `select-tables.php`
   * decides with `strstr()`, so `legacy_wp_posts` counts as this install's table and ships ticked;
   * a starts-with test would call that a failure. (The *job option* disagrees:
   * `class-jobtype-dbdump.php` builds its default exclusion list with `strncmp()`, a true prefix
   * test. This method asserts the screen, so it follows the screen's rule.)
   *
   * The population is asserted first for the same reason as
   * {@link expectAllFileAreasIncluded}: "nothing unticked" is trivially true of an empty list.
   *
   * @param prefix - this install's table prefix, from `wp db prefix`. Never hard-code it: a site
   * not using the default would otherwise be asserted against the wrong set entirely.
   * @param options.timeout - budget for each assertion, in ms.
   */
  async expectDefaultTableSelection(
    prefix: string,
    options: { timeout?: number } = {},
  ): Promise<void> {
    const budget =
      options.timeout === undefined ? {} : { timeout: options.timeout };
    const ours = `[name="tabledb[]"][value*="${prefix}"]`;
    await expect(this.tableList.locator(ours)).not.toHaveCount(0, budget);
    await expect(this.tableList.locator(`${ours}:not(:checked)`)).toHaveCount(
      0,
      budget,
    );
    await expect(
      this.tableList.locator(
        `[name="tabledb[]"]:not([value*="${prefix}"]):checked`,
      ),
    ).toHaveCount(0, budget);
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
   *
   * The list is required to be non-empty first — an empty one satisfies "nothing is unticked"
   * without a single table having been checked.
   */
  async expectAllTablesSelected(): Promise<void> {
    await expect(this.tableCheckboxes).not.toHaveCount(0);
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

  // ── Dismissing ───────────────────────────────────────────────────────────────

  /** One of the two panes, by name. */
  private pane(pane: "files" | "tables"): Locator {
    return pane === "files" ? this.filesContainer : this.tablesContainer;
  }

  /**
   * Dismisses a pane without saving, via its header's ✕.
   *
   * Needed because these panes are read as often as they are edited: a scenario checking what a
   * job *currently* covers must leave the screen as it found it, and "save" is not a neutral way
   * to close something. The control works on both screens — it is bound at page load for the
   * onboarding's pre-rendered panes and re-bound by the fetch handler for a job screen's.
   *
   * @param pane - which pane's header to close from.
   */
  async close(pane: "files" | "tables"): Promise<void> {
    await this.pane(pane).locator(".js-backwpup-close-sidebar").first().click();
    await this.expectClosed(pane);
  }

  /**
   * Asserts a pane has been dismissed.
   *
   * Also the completion signal after a **save**: both save handlers close the sidebar themselves on
   * success, so a caller that saves and then acts on the page underneath needs to know the aside
   * has moved out of the way rather than assume it.
   *
   * The signal is the panel leaving the viewport, **not** it being hidden: closing parks the whole
   * aside off-screen and leaves the panes visible (see {@link expectPanelClosed}).
   */
  async expectClosed(pane: "files" | "tables"): Promise<void> {
    await expectPanelClosed(this.pane(pane));
  }
}
