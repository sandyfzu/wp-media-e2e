import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { BackupHistoryTable } from "./backup-history.table";
import { DashboardPage } from "./dashboard.page";
import { DataSelectionSidebar } from "./data-selection.sidebar";
import { FirstBackupPage } from "./first-backup.page";
import { FrequencySidebar } from "./frequency.sidebar";
import { OnboardingPage } from "./onboarding.page";
import { StorageSidebar } from "./storage.sidebar";
import {
  STORAGE_LABELS,
  STORAGE_PANEL_TITLES,
  PRO_ONLY_STORAGES,
} from "./storages";
import type { StorageSlug } from "./storages";
import { FIXTURE_STYLES } from "./__fixtures__/styles";
import { renderFixture } from "./__fixtures__/render";

/**
 * **The locator contract — this suite is the version-drift alarm.**
 *
 * Every fixture under `__fixtures__/` was **captured from a real WordPress on a real cell**, never
 * hand-written. That is the whole point: a hand-written fixture drifts *with* the page object, so a
 * wrong locator and a wrong fixture agree with each other and the spec passes while the real page
 * fails. Captured markup can only agree with the plugin.
 *
 * When a future build changes the markup, these tests fail as one clear unit-test failure naming the
 * locator, instead of the same change surfacing as a scatter of unrelated scenario timeouts.
 *
 * **The sidebar fixtures come in pairs, one per screen, and that is not redundancy.** BackWPup loads
 * every panel into one `#backwpup-sidebar` aside, but *which* panels are populated — and under which
 * root — depends on whether `backwpup_onboarding` is set. Onboarding fills `#sidebar-select-files` and
 * `#sidebar-select-tables` directly and leaves `#sidebar-storages` empty; a job card fills
 * `#sidebar-settings-data-type` (with both data panes nested inside it) and leaves those two articles
 * **permanently empty**. A single fixture can only ever describe one of those worlds, which is exactly
 * how the empty-shell trap in {@link DataSelectionSidebar} went unnoticed. So:
 * `sidebars-onboarding.html` is onboarding's aside, `sidebars-dashboard.html` is a job screen's, and
 * the two describes below assert each against the object that has to serve both.
 *
 * **Assertions are count-based, not visibility-based.** The fixtures carry the plugin's markup but
 * not its stylesheet or its JavaScript, so `hidden` classes have no effect and every element would
 * report "visible" — a visibility assertion here would therefore be vacuous. (On the *live* page a
 * visibility check is weak for a different reason: closing the sidebar parks the whole aside
 * off-screen with `translate-x-[450px]`, and a translated element still reports a bounding box, so
 * every article inside it keeps satisfying `toBeVisible()`. `toBeInViewport()` is the honest signal
 * there — see `frequency.sidebar.ts`'s `close()`.) Resolving to exactly one element is the property
 * that actually matters for a locator and is the one a static fixture can honestly prove.
 *
 * **Re-capturing:** run `npm run fixtures:capture` (`capture-backwpup-fixtures.ts`). It removes any
 * existing BackWPup **including its options**, installs the plugin fresh on the configured cell,
 * walks onboarding and then the dashboard, and writes every fixture here from the live DOM — stripping `<svg>`/`<script>`/`<style>` and replacing three classes of
 * per-capture noise: the site's hostname (`wordpress.test`), WordPress's nonces (`0000000000`), and
 * credential-shaped field values (`REDACTED`, because a storage panel renders saved settings — even a
 * decrypted FTP password — straight into `value` attributes). Nothing else is edited, and the script
 * refuses to write a file with an un-sanitised nonce still in it. The fresh install matters as much
 * as the sanitising: capturing over a site that has been driven before records *that run's* job
 * settings — an excluded file area, say — as if they were the shape of a new install. The directory
 * is in `.prettierignore` precisely so nothing reflows the markup afterwards — a reformat would break the
 * "nobody edited this" guarantee and let a Prettier upgrade masquerade as plugin drift.
 *
 * Current captures: **BackWPup Pro 5.7.5** (latest stable). Re-measured 2026-08-28 against the
 * `develop` build the cells actually install (`9.99.99-90f93911`): `components/`, `pages/`,
 * `parts/`, `pro/parts/` and `assets/js/` are **byte-identical** between the two, as are the whole
 * of `src/` (so every REST route) and `src/Cli/Commands/`. What differs is `inc/`'s three
 * archive-engine files, the version header, the readme, the translation template and `vendor/` —
 * none of which these captures describe. So they describe the build under test as well as 5.7.5.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");

const fixture = (name: string): string =>
  readFileSync(join(FIXTURES, name), "utf8");

const ONBOARDING = fixture("onboarding.html");
const DASHBOARD = fixture("dashboard.html");
/** The `#backwpup-sidebar` aside + `#backwpup-modal`, once per screen — see the header. */
const SIDEBARS_ONBOARDING = fixture("sidebars-onboarding.html");
const SIDEBARS_DASHBOARD = fixture("sidebars-dashboard.html");
/** The screen onboarding hands over to, captured at its first render — mid-run, panel still hidden. */
const FIRST_BACKUP = fixture("first-backup.html");

/** Every storage the pickers offer, in the order the plugin renders them. */
const ALL_STORAGES = Object.keys(STORAGE_LABELS) as StorageSlug[];

/**
 * Reveals one captured sidebar pane, exactly as the plugin's own `openSidebar()` does.
 *
 * The sidebar fixtures were captured with the aside closed, so every article carries an inline
 * `display: none` — faithful to the page at that moment, and the reason a *click* assertion cannot
 * run against them untouched. Only that one inline property is cleared; the markup is otherwise the
 * capture, so the locators still have to earn their match.
 */
async function revealPane(page: Page, selector: string): Promise<void> {
  await page.locator(selector).evaluate((element: HTMLElement) => {
    element.style.display = "";
  });
}

/**
 * Renames one captured table checkbox, standing in for a table the capture's database cannot hold.
 *
 * The `value` **attribute** is what the selectors match, so it is what changes here; `:checked`
 * keeps reflecting the property the capture set, which is the point — the table stays ticked and
 * only its name moves.
 */
async function renameTable(
  page: Page,
  from: string,
  to: string,
): Promise<void> {
  await page
    .locator(`[name="tabledb[]"][value="${from}"]`)
    .evaluate((input, name: string) => {
      input.setAttribute("value", name);
    }, to);
}

test.describe("OnboardingPage — locator contract", () => {
  test.beforeEach(async ({ page }) => {
    await renderFixture(page, ONBOARDING);
  });

  test("onboarding's heading and all three step panes resolve", async ({
    page,
  }) => {
    const onboarding = new OnboardingPage(page);
    await expect(
      page.getByRole("heading", {
        name: "Ready to set up your first backup?",
      }),
    ).toHaveCount(1);
    for (const step of [1, 2, 3] as const) {
      await expect(onboarding.pane(step)).toHaveCount(1);
    }
  });

  test("step navigation triggers resolve, one per transition", async ({
    page,
  }) => {
    const onboarding = new OnboardingPage(page);
    // Forward from 1, forward from 2, back from 2, back from 3 — each lives in its own pane, which
    // is why the trigger classes can repeat across panes without ambiguity.
    await expect(
      onboarding.pane(1).locator(".js-backwpup-onboarding-step-2"),
    ).toHaveCount(1);
    await expect(
      onboarding.pane(2).locator(".js-backwpup-onboarding-step-3"),
    ).toHaveCount(1);
    await expect(
      onboarding.pane(2).locator(".js-backwpup-onboarding-step-1"),
    ).toHaveCount(1);
    await expect(
      onboarding.pane(3).locator(".js-backwpup-onboarding-step-2"),
    ).toHaveCount(1);
    await expect(
      onboarding.pane(3).locator(".js-backwpup-onboarding-submit-form"),
    ).toHaveCount(1);
  });

  // These switches are sr-only AND aria-hidden with textless labels, so this is the check that the
  // id-based handles still exist — the day they change, role/label locators still will not help.
  test("data-selection switches and their visible proxies resolve", async ({
    page,
  }) => {
    for (const id of ["backup_files", "backup_database"]) {
      await expect(page.locator(`#${id}`)).toHaveCount(1);
      await expect(page.locator(`label[for="${id}"]`)).toHaveCount(1);
    }
  });

  test("the switches really are unreachable by role, justifying the id handles", async ({
    page,
  }) => {
    // If this ever fails, the plugin has made them accessible and toggles.ts can be simplified.
    //
    // Scoped to step 1, where the switches live, and NOT page-wide: `getByRole`'s `name` matches a
    // case-insensitive **substring**, and the capture also carries every storage panel — whose
    // unrelated checkboxes ("Encrypt files…", "…files will be deleted permanently") contain "files"
    // and would make a page-wide count non-zero for reasons that say nothing about these switches.
    const onboarding = new OnboardingPage(page);
    for (const name of ["Files", "Database"]) {
      await expect(
        onboarding.pane(1).getByRole("checkbox", { name }),
        `step-1 ${name} switch must be invisible to the a11y tree`,
      ).toHaveCount(0);
      await expect(
        onboarding.pane(1).locator(`#backup_${name.toLowerCase()}`),
        `…while its id handle still resolves`,
      ).toHaveCount(1);
    }
  });

  test("each step-1 exclusion trigger resolves by its own data-content", async ({
    page,
  }) => {
    const onboarding = new OnboardingPage(page);
    for (const content of ["select-files", "select-tables"]) {
      await expect(
        onboarding
          .pane(1)
          .locator(
            `.js-backwpup-load-and-open-sidebar[data-content="${content}"]`,
          ),
      ).toHaveCount(1);
    }
  });

  test("both frequency selects resolve and offer the four intervals", async ({
    page,
  }) => {
    const onboarding = new OnboardingPage(page);
    for (const kind of ["files", "database"] as const) {
      const select = onboarding.frequencySelect(kind);
      await expect(select).toHaveCount(1);
      const values = await select
        .locator("option")
        .evaluateAll((options) =>
          options.map((option) => (option as HTMLOptionElement).value),
        );
      expect(values).toEqual(["hourly", "daily", "weekly", "monthly"]);
    }
  });

  test("the frequency selects really are unreachable by label", async ({
    page,
  }) => {
    // Their <label> uses name= rather than for=, so it is not a programmatic label. Documented in
    // the POM; asserted here so a future fix is noticed rather than assumed.
    await expect(page.getByLabel("Frequency")).toHaveCount(0);
  });

  test("each advanced-frequency trigger pairs with its own frequency select by job id", async ({
    page,
  }) => {
    // What `openAdvancedFrequency` rests on: the "Advanced settings" button beside a kind's
    // frequency field carries the same job id that field names itself with. Asserted against
    // captured markup, so a build that renames either half fails here instead of silently opening
    // the other job's panel — which no scenario assertion downstream could tell apart.
    const onboarding = new OnboardingPage(page);
    await expect(
      onboarding
        .pane(2)
        .locator(
          '.js-backwpup-load-and-open-sidebar[data-content="frequency"]',
        ),
    ).toHaveCount(2);

    const ids: string[] = [];
    for (const kind of ["files", "database"] as const) {
      const field = await onboarding.frequencySelect(kind).getAttribute("name");
      const jobId = /^job_(\d+)_frequency$/.exec(field ?? "")?.[1];
      expect(
        jobId,
        `the ${kind} frequency field names its job id`,
      ).toBeDefined();
      await expect(
        onboarding
          .pane(2)
          .locator(
            `.js-backwpup-load-and-open-sidebar[data-content="frequency"][data-job-id="${jobId ?? ""}"]`,
          ),
        `the ${kind} advanced-settings trigger`,
      ).toHaveCount(1);
      ids.push(jobId ?? "");
    }
    // Distinct ids: a build that pointed both halves at one job would satisfy every assertion above
    // while making the two-job scenarios meaningless.
    expect(new Set(ids).size, "files and database are different jobs").toBe(2);
  });

  test("every storage tile resolves, with its hidden checkbox", async ({
    page,
  }) => {
    const onboarding = new OnboardingPage(page);
    for (const slug of ALL_STORAGES) {
      await expect(
        onboarding.storageTile(slug),
        `storage tile for ${slug}`,
      ).toHaveCount(1);
      await expect(
        onboarding.pane(3).locator(`#destination-${slug}`),
        `hidden checkbox for ${slug}`,
      ).toHaveCount(1);
    }
  });

  // The tile takes its accessible name from the <label> it contains, so the labels map must stay in
  // step with the rendered text — otherwise a scenario asserting on what the user reads is wrong.
  test("each storage tile's accessible name matches STORAGE_LABELS", async ({
    page,
  }) => {
    const onboarding = new OnboardingPage(page);
    for (const slug of ALL_STORAGES) {
      await expect(
        onboarding
          .pane(3)
          .getByRole("button", { name: STORAGE_LABELS[slug], exact: true }),
        `role/name locator for ${slug} ("${STORAGE_LABELS[slug]}")`,
      ).toHaveCount(1);
    }
  });

  test("on a Pro build nothing is locked, so no upsell markup is present", async ({
    page,
  }) => {
    // The captured fixture is a Pro render. Locked entries are a Free-only rendering, which is
    // why expectStorageLocked can only be exercised on a Free cell.
    await expect(page.locator("li.js-backwpup-locked-storage")).toHaveCount(0);
    for (const slug of PRO_ONLY_STORAGES) {
      await expect(
        new OnboardingPage(page).storageTile(slug),
        `${slug} is selectable on Pro`,
      ).toHaveCount(1);
    }
  });

  test("onboarding's submit ships disabled until a storage is chosen", async ({
    page,
  }) => {
    await expect(
      page.locator(".js-backwpup-onboarding-submit-form"),
    ).toBeDisabled();
  });

  // The other side of the same product rule: with something to back up, step 1 lets the user leave.
  // The plugin disables this button only once both data types are off, which onboarding never ships.
  test("step 1 ships able to continue", async ({ page }) => {
    const onboarding = new OnboardingPage(page);
    await onboarding.expectCanContinueToSchedule(true);
  });
});

test.describe("OnboardingPage — toggle behaviour on captured markup", () => {
  // Clicking a <label for=…> natively toggles its checkbox, so these exercise the real interaction
  // against the plugin's own markup with no plugin JavaScript. They do need the style shim: the
  // proxies' size comes from utility classes, and the captured HTML carries no stylesheet.
  test("setDataIncluded toggles the hidden switch and is idempotent", async ({
    page,
  }) => {
    await renderFixture(page, FIXTURE_STYLES + ONBOARDING);
    const onboarding = new OnboardingPage(page);
    const files = page.locator("#backup_files");

    await expect(files).toBeChecked(); // the plugin ships both areas included
    await onboarding.setDataIncluded("files", false);
    await expect(files).not.toBeChecked();

    // Already in the wanted state: must not toggle back.
    await onboarding.setDataIncluded("files", false);
    await expect(files).not.toBeChecked();

    await onboarding.setDataIncluded("files", true);
    await expect(files).toBeChecked();
  });

  test("setFrequency selects and verifies the value", async ({ page }) => {
    await renderFixture(page, ONBOARDING);
    const onboarding = new OnboardingPage(page);
    await onboarding.setFrequency("database", "daily");
    await expect(onboarding.frequencySelect("database")).toHaveValue("daily");
  });
});

test.describe("DashboardPage — locator contract", () => {
  test.beforeEach(async ({ page }) => {
    await renderFixture(page, DASHBOARD);
  });

  test("the two dashboard-only headings resolve", async ({ page }) => {
    await expect(
      page.getByRole("heading", { name: "Next Scheduled Backups" }),
    ).toHaveCount(1);
    await expect(
      page.getByRole("heading", { name: "Backups History" }),
    ).toHaveCount(1);
  });

  test("the Backup Now trigger resolves", async ({ page }) => {
    await expect(
      page.locator('.js-backwpup-open-modal[data-content="backup-now"]'),
    ).toHaveCount(1);
  });

  // Two exist in the page header — a labelled one and an icon-only one for narrow viewports.
  // Both must be found by the trigger class, since the icon-only one has no accessible name at all.
  //
  // `:not(#backwpup-sidebar *)` excludes the aside, where five more carry the same `data-content`:
  // each Advanced-settings sub-panel (jobs, logs, network, encryption, license) renders its own
  // "Back to Advanced Settings" button. `openAdvancedSettings` never hits them because it filters to
  // the visible one and those panels are hidden — but a bare page-wide count would read 7.
  const HEADER_ADVANCED =
    '.js-backwpup-open-sidebar[data-content="advanced-settings"]:not(#backwpup-sidebar *)';

  test("both Advanced settings triggers resolve by trigger class", async ({
    page,
  }) => {
    await expect(page.locator(HEADER_ADVANCED)).toHaveCount(2);
    // The aside's own back-links are the reason the scoping above is load-bearing.
    await expect(
      page.locator(
        '.js-backwpup-open-sidebar[data-content="advanced-settings"]',
      ),
    ).toHaveCount(7);
  });

  test("the icon-only variant genuinely has no accessible name", async ({
    page,
  }) => {
    // Justifies the locator policy's icon-only exception: were this to gain a name, the trigger class could go.
    // Same scoping as above — and `and()` is how a role locator gets constrained to a subtree here.
    const named = page
      .getByRole("button", { name: "Advanced settings" })
      .and(page.locator(":not(#backwpup-sidebar *)"));
    await expect(named).toHaveCount(1);
  });

  test("the job-card region and the add-backup card resolve", async ({
    page,
  }) => {
    const dashboard = new DashboardPage(page);
    // The plugin's own id misspells "backwpup" — asserted so a future correction is caught here.
    await expect(page.locator("#backwup-next-scheduled-backups")).toHaveCount(
      1,
    );
    await expect(dashboard.addBackupCard).toHaveCount(1);
    await expect(
      dashboard.addBackupCard.getByRole("button", { name: "Add a new backup" }),
    ).toHaveCount(1);
  });

  test("the running-job region resolves and is pre-rendered", async ({
    page,
  }) => {
    // Pre-rendered with display:none, which is exactly why JobRunPanel never asserts presence.
    await expect(page.locator("#runningjob")).toHaveCount(1);
    await expect(
      page.locator("#backupgeneration-progress-box-title"),
    ).toHaveCount(1);
    await expect(page.locator("#abortbutton")).toHaveCount(1);
    await expect(page.locator("#showworkingclose")).toHaveCount(1);
    await expect(page.locator(".js-backwpup-current-file")).toHaveCount(1);
    await expect(
      page.locator("#runningjob .progress-bar .progress-step"),
    ).toHaveCount(1);
  });
});

test.describe("BackupHistoryTable — locator contract", () => {
  test.beforeEach(async ({ page }) => {
    await renderFixture(page, DASHBOARD);
  });

  test("the table and its loading placeholder resolve", async ({ page }) => {
    await expect(page.locator("#backwpup-backup-history")).toHaveCount(1);
    await expect(page.locator("#backwpup-backup-history-loading")).toHaveCount(
      1,
    );
  });

  test("the header renders the five expected columns", async ({ page }) => {
    // Asserted as text, not by counting <td>s — the failure branch changes the fifth column's
    // meaning, which is what made the baseline's column-counting approach wrong.
    const headers = page
      .locator("#backwpup-backup-history thead th")
      .filter({ hasText: /\S/ });
    await expect(headers).toHaveText([
      "Created at",
      "Type",
      "Stored on",
      "Data",
      "Actions",
    ]);
  });

  test("bulk-action controls resolve, with Apply disabled and delete offered", async ({
    page,
  }) => {
    await expect(page.locator("#bulk-actions-select")).toHaveCount(1);
    await expect(page.locator("#bulk-actions-apply")).toBeDisabled();
    await expect(
      page.locator('#bulk-actions-select option[value="delete"]'),
    ).toHaveCount(1);
  });

  test("select-all resolves inside the table header", async ({ page }) => {
    await expect(
      page.locator("#backwpup-backup-history .js-backwpup-select-all"),
    ).toHaveCount(1);
  });

  test("with only the placeholder row present, there are no backup rows", async ({
    page,
  }) => {
    // Proves the row locator excludes the placeholder — the property that stops a
    // pre-load count assertion from passing for the wrong reason.
    const table = new BackupHistoryTable(page);
    await expect(table.rows).toHaveCount(0);
  });
});

test.describe("BackupHistoryTable — a real captured row", () => {
  // `history-row.html` is the history table captured after a **real** database backup ran on the cell,
  // so this is the genuine row markup rather than a reconstruction.
  const HISTORY_ROW = fixture("history-row.html");

  test.beforeEach(async ({ page }) => {
    await renderFixture(page, HISTORY_ROW);
  });

  test("the row is keyed by the plugin's backup id", async ({ page }) => {
    const table = new BackupHistoryTable(page);
    await expect(table.rows).toHaveCount(1);
    await expect(table.newestRow).toHaveAttribute("data-backup-id", "1");
    await expect(table.row(1)).toHaveCount(1);
    await expect(table.row("1")).toHaveCount(1);
    await expect(table.row(99)).toHaveCount(0);
  });

  test("the loading placeholder is gone once rows have arrived", async ({
    page,
  }) => {
    await new BackupHistoryTable(page).waitForLoaded();
  });

  test("a successful backup registers no failure", async ({ page }) => {
    await new BackupHistoryTable(page).expectNoFailures();
  });

  test("the row's per-backup actions resolve", async ({ page }) => {
    const row = new BackupHistoryTable(page).newestRow;
    // View log and Delete open modals identified by data-content; Download has its own trigger
    // class; Restore is located by the modal it opens, because its label is data-driven.
    await expect(row.locator('[data-content="backup-log"]')).not.toHaveCount(0);
    await expect(row.locator('[data-content="delete-backup"]')).not.toHaveCount(
      0,
    );
    await expect(
      row.locator('[data-content="restore-backup"]'),
    ).not.toHaveCount(0);
    await expect(row.locator(".js-backwpup-download-backup")).not.toHaveCount(
      0,
    );
  });

  test("the row's selection checkbox resolves", async ({ page }) => {
    await expect(
      new BackupHistoryTable(page).newestRow.locator(
        ".js-backwpup-select-backup",
      ),
    ).not.toHaveCount(0);
  });

  test("the desktop action menu resolves", async ({ page }) => {
    const row = new BackupHistoryTable(page).newestRow;
    await expect(row.locator(".js-backwpup-menu")).not.toHaveCount(0);
    await expect(row.locator(".js-backwpup-menu-content")).not.toHaveCount(0);
  });
});

test.describe("BackupHistoryTable — the failure branch", () => {
  // No failed backup exists on the cell to capture, so this reproduces the row template's
  // failed/aborted branch (`components/table-row-backups.php`). Both statuses take that branch and
  // both get the `delete-failed-backup` delete control, but only `failed` gets the
  // `.backwpup-failure-icon` class — an aborted backup is styled `text-alert` instead. The rows
  // below carry exactly what the template emits for each, so a POM that filtered on the icon would
  // pass the first case and miss the second.
  const MIXED = `<table id="backwpup-backup-history"><tbody>
    <tr data-backup-id="11"><td>ok</td><td><button data-content="delete-backup">Delete</button></td></tr>
    <tr data-backup-id="12"><td><span class="backwpup-failure-icon"></span><span>Website Server backup failed – disk full</span></td><td><button data-content="delete-failed-backup">Delete</button></td></tr>
    <tr data-backup-id="13"><td>ok</td><td><button data-content="delete-backup">Delete</button></td></tr>
    <tr data-backup-id="14"><td><span class="inline-flex items-center justify-center text-alert"></span><span>Aborted by user</span></td><td><button data-content="delete-failed-backup">Delete</button></td></tr>
  </tbody></table>`;

  test("failedRows finds both unsuccessful branches and nothing else", async ({
    page,
  }) => {
    await renderFixture(page, MIXED);
    const table = new BackupHistoryTable(page);
    await expect(table.rows).toHaveCount(4);
    await expect(table.failedRows).toHaveCount(2);
    expect(
      await table.failedRows.evaluateAll((rows) =>
        rows.map((row) => row.getAttribute("data-backup-id")),
      ),
    ).toEqual(["12", "14"]);
  });

  test("an aborted backup counts as a failure, though it carries no failure icon", async ({
    page,
  }) => {
    await renderFixture(page, MIXED);
    // Pins the reason `failedRows` cannot key on the icon: the aborted row genuinely has none.
    const table = new BackupHistoryTable(page);
    await expect(table.row(14).locator(".backwpup-failure-icon")).toHaveCount(
      0,
    );
    await expect(
      table.failedRows.filter({ hasText: "Aborted by user" }),
    ).toHaveCount(1);
  });

  test("abortedRows finds the aborted run and not the one that failed on its own", async ({
    page,
  }) => {
    await renderFixture(page, MIXED);
    const table = new BackupHistoryTable(page);
    expect(
      await table.abortedRows.evaluateAll((rows) =>
        rows.map((row) => row.getAttribute("data-backup-id")),
      ),
    ).toEqual(["14"]);
  });

  test("expectNoFailures fails when a failed row is present", async ({
    page,
  }) => {
    await renderFixture(page, MIXED);
    // The assertion the baseline never had: a failed backup must fail the scenario.
    await expect(
      new BackupHistoryTable(page).expectNoFailures(),
    ).rejects.toThrow();
  });
});

test.describe("Sidebars — onboarding's aside", () => {
  test.beforeEach(async ({ page }) => {
    await renderFixture(page, SIDEBARS_ONBOARDING);
  });

  test("both data panes fill their own top-level article", async ({ page }) => {
    // Onboarding asks for these blocks by name, so each lands in the article named after it. This is
    // the shape `DataSelectionSidebar` must handle *in addition to* the job-screen one below.
    const sidebar = new DataSelectionSidebar(page);
    await expect(sidebar.filesContainer).toHaveCount(1);
    await expect(sidebar.filesContainer).toHaveAttribute(
      "id",
      "sidebar-select-files",
    );
    await expect(sidebar.tablesContainer).toHaveCount(1);
    await expect(sidebar.tablesContainer).toHaveAttribute(
      "id",
      "sidebar-select-tables",
    );
  });

  test("Select Files: area switches, exclusion triggers and submit resolve", async ({
    page,
  }) => {
    const sidebar = new DataSelectionSidebar(page);
    for (const name of [
      "backuproot",
      "backupcontent",
      "backupplugins",
      "backupthemes",
      "backupuploads",
    ]) {
      await expect(
        sidebar.filesContainer.locator(`[name="${name}"]`),
        `file-area switch ${name}`,
      ).toHaveCount(1);
    }
    await expect(sidebar.extraFolders).toHaveCount(1);
    await expect(sidebar.excludedFiles).toHaveCount(1);
    await expect(
      sidebar.filesContainer.locator("#file-exclusions-submit"),
    ).toHaveCount(1);
  });

  test("Select Files: each area's exclusion trigger and its modal both exist", async ({
    page,
  }) => {
    // The modals live in `#backwpup-modal`, which this fixture also carries — so the trigger and the
    // panel it dispatches to can be checked as a pair rather than trusting the naming convention.
    for (const content of [
      "exclude-files-core",
      "exclude-files-wp-content",
      "exclude-files-plugins",
      "exclude-files-themes",
      "exclude-files-uploads",
    ]) {
      await expect(
        page.locator(`#sidebar-select-files [data-content="${content}"]`),
        `trigger for ${content}`,
      ).toHaveCount(1);
      await expect(
        page.locator(`#sidebar-${content}`),
        `modal for ${content}`,
      ).toHaveCount(1);
    }
  });

  test("Select Tables: list, filter, select-all and submit resolve", async ({
    page,
  }) => {
    const sidebar = new DataSelectionSidebar(page);
    await expect(sidebar.tableList).toHaveCount(1);
    await expect(
      sidebar.tablesContainer.locator('[name="filter_tables"]'),
    ).toHaveCount(1);
    await expect(
      sidebar.tablesContainer.locator('[name="select_all_tables"]'),
    ).toHaveCount(1);
    await expect(
      sidebar.tablesContainer.locator("#save-excluded-tables"),
    ).toHaveCount(1);
  });

  test("Select Tables: the captured render offers real tables", async ({
    page,
  }) => {
    // A live database render, so the exact count is environment-specific — but it must be non-zero,
    // which is what proves the `tabledb[]` handle is right.
    const sidebar = new DataSelectionSidebar(page);
    expect(await sidebar.tableCheckboxes.count()).toBeGreaterThan(0);
  });

  // The defaults a new job starts from, which the first three onboarding scenarios assert before
  // touching anything. Pinning them here means a build that changes them fails as one clear unit
  // test rather than as three unrelated scenario failures.
  test("a new job ships with every file area and every table included", async ({
    page,
  }) => {
    const sidebar = new DataSelectionSidebar(page);
    await sidebar.expectAllFileAreasIncluded();
    // The capture's site uses the stock prefix and holds nothing else, so both halves of the rule
    // are exercised: every `wp_` table ticked, nothing outside the prefix ticked.
    await sidebar.expectDefaultTableSelection("wp_");
  });

  // A negative check on the same assertions: they must actually be able to fail. A selector that
  // matched nothing would satisfy `toHaveCount(0)` forever — the exact defect a post-implementation
  // audit found in an earlier `expectAllTablesSelected`.
  test("the default-selection assertions fail when a box is unticked", async ({
    page,
  }) => {
    await renderFixture(page, FIXTURE_STYLES + SIDEBARS_ONBOARDING);
    await revealPane(page, "#sidebar-select-files");
    await revealPane(page, "#sidebar-select-tables");
    const sidebar = new DataSelectionSidebar(page);

    await sidebar.setFileAreaIncluded("plugins", false);
    await expect(
      sidebar.expectAllFileAreasIncluded({ timeout: 500 }),
    ).rejects.toThrow();

    await sidebar.setTableIncluded("wp_options", false);
    await expect(
      sidebar.expectDefaultTableSelection("wp_", { timeout: 500 }),
    ).rejects.toThrow();
  });

  // The rule is `strstr()`, not a prefix test: `select-tables.php` ticks any table whose name
  // *contains* the prefix. The capture's database holds only `wp_*` tables, so the distinction is
  // invisible here until a table is renamed into it — which is exactly how a starts-with selector
  // passed review and would have failed on a site with, say, a `legacy_wp_*` table.
  test("a table that merely contains the prefix counts as this install's", async ({
    page,
  }) => {
    await renderFixture(page, FIXTURE_STYLES + SIDEBARS_ONBOARDING);
    await revealPane(page, "#sidebar-select-tables");
    await renameTable(page, "wp_options", "legacy_wp_options");
    await new DataSelectionSidebar(page).expectDefaultTableSelection("wp_", {
      timeout: 2000,
    });
  });

  // The half the capture cannot exercise on its own: with every table prefixed, "no foreign table
  // is ticked" is vacuously true. One renamed table is enough to prove the assertion has teeth.
  test("a foreign table left ticked fails the default-selection check", async ({
    page,
  }) => {
    await renderFixture(page, FIXTURE_STYLES + SIDEBARS_ONBOARDING);
    await revealPane(page, "#sidebar-select-tables");
    await renameTable(page, "wp_options", "other_app_settings");
    await expect(
      new DataSelectionSidebar(page).expectDefaultTableSelection("wp_", {
        timeout: 500,
      }),
    ).rejects.toThrow();
  });

  // `toHaveCount(0)` over a filtered set is satisfied by a pane that rendered nothing at all, so
  // each of these assertions requires its population first. Without that, a panel that failed to
  // load would report every area and every table as included.
  test("the default-selection checks cannot pass against an empty pane", async ({
    page,
  }) => {
    await renderFixture(page, FIXTURE_STYLES + SIDEBARS_ONBOARDING);
    await revealPane(page, "#sidebar-select-files");
    await revealPane(page, "#sidebar-select-tables");
    const sidebar = new DataSelectionSidebar(page);
    await page.evaluate(() => {
      document
        .querySelectorAll('input[name^="backup"], input[name="tabledb[]"]')
        .forEach((input) => {
          input.remove();
        });
    });

    await expect(
      sidebar.expectAllFileAreasIncluded({ timeout: 500 }),
    ).rejects.toThrow();
    await expect(
      sidebar.expectDefaultTableSelection("wp_", { timeout: 500 }),
    ).rejects.toThrow();
    await expect(sidebar.expectAllTablesSelected()).rejects.toThrow();
  });

  test("Select Tables: one table can be addressed and toggled by name", async ({
    page,
  }) => {
    await renderFixture(page, FIXTURE_STYLES + SIDEBARS_ONBOARDING);
    await revealPane(page, "#sidebar-select-tables");
    const sidebar = new DataSelectionSidebar(page);
    const table = "wp_options";
    await expect(sidebar.tableCheckbox(table)).toHaveCount(1);

    await sidebar.setTableIncluded(table, false);
    await sidebar.expectTableIncluded(table, false);
    // Idempotent, like every other toggle: asking again must not tick it back on.
    await sidebar.setTableIncluded(table, false);
    await sidebar.expectTableIncluded(table, false);

    await sidebar.setTableIncluded(table, true);
    await sidebar.expectTableIncluded(table, true);
  });

  test("the storage picker ships EMPTY during onboarding", async ({ page }) => {
    // `storages.php` returns early while `backwpup_onboarding` is set, so onboarding has no picker at
    // all — its destinations are tiles in step 3 instead. A scenario that opened `StorageSidebar` here
    // would find a container that resolves and never fills.
    const sidebar = new StorageSidebar(page);
    await expect(sidebar.container).toHaveCount(1);
    await expect(sidebar.container.locator("*")).toHaveCount(0);
  });

  test("every provider panel is pre-rendered, with its save-and-test trigger", async ({
    page,
  }) => {
    // All eleven, not a subset: onboarding renders every provider's form into the page up front, which
    // is why `OnboardingPage.openStorageSettings` fires no request.
    const sidebar = new StorageSidebar(page);
    for (const slug of ALL_STORAGES) {
      await expect(sidebar.panel(slug), `panel for ${slug}`).toHaveCount(1);
      await expect(
        sidebar.panel(slug).locator(`.js-backwpup-test-${slug}-storage`),
        `save-and-test trigger for ${slug}`,
      ).toHaveCount(1);
    }
  });

  test("no provider panel offers 'Back to Storages' here", async ({ page }) => {
    // The back link is emitted only when a panel is rendered with `is_in_form === false`, which only
    // happens when the dashboard's picker fetches it. During onboarding `storage-*.php` forces
    // `is_in_form = true` (its empty-`job_id` fallback), so the link can never appear — see the
    // job-screen counterpart below.
    await expect(
      page.locator('[data-content="storages"]'),
      "onboarding provider panels must have no route back to a picker that does not exist",
    ).toHaveCount(0);
  });

  test("panels onboarding suppresses are present but empty", async ({
    page,
  }) => {
    // Each of these returns early while onboarding is set. They resolve, so a presence check would
    // pass — which is exactly the trap the two-fixture split exists to expose.
    for (const id of [
      "sidebar-advanced-settings",
      "sidebar-settings-jobs",
      "sidebar-settings-logs",
      "sidebar-settings-network",
      "sidebar-settings-data-type",
    ]) {
      await expect(page.locator(`#${id}`), `${id} exists`).toHaveCount(1);
      await expect(
        page.locator(`#${id}`).locator("*"),
        `${id} is empty during onboarding`,
      ).toHaveCount(0);
    }
  });

  test("Frequency: onboarding does NOT offer 'Triggered by link'", async ({
    page,
  }) => {
    // `frequency.php:62-64` appends `link` only when `backwpup_onboarding` is unset. This is the
    // captured proof that `Frequency`'s `link` member is onboarding-gated, not edition-gated.
    const sidebar = new FrequencySidebar(page);
    await expect(sidebar.frequencySelect).toHaveCount(1);
    const values = await sidebar.frequencySelect
      .locator("option")
      .evaluateAll((options) =>
        options.map((option) => (option as HTMLOptionElement).value),
      );
    expect(values).toEqual(["hourly", "daily", "weekly", "monthly"]);
  });

  test("Backup Now modal: the Start trigger resolves", async ({ page }) => {
    await expect(
      page.locator("#sidebar-backup-now .js-backwpup-start-backup-now"),
    ).toHaveCount(1);
  });
});

test.describe("Sidebars — a job screen's aside", () => {
  test.beforeEach(async ({ page }) => {
    await renderFixture(page, SIDEBARS_DASHBOARD);
  });

  test("the top-level data articles are permanently empty shells", async ({
    page,
  }) => {
    // The trap this fixture exists for. Both resolve — a presence or visibility check passes — and
    // neither is ever filled on this screen, because only onboarding requests those blocks by name.
    for (const id of ["sidebar-select-files", "sidebar-select-tables"]) {
      await expect(page.locator(`#${id}`), `${id} exists`).toHaveCount(1);
      await expect(
        page.locator(`#${id}`).locator("*"),
        `${id} must be an empty shell on a job screen`,
      ).toHaveCount(0);
    }
  });

  test("both data panes resolve to the sections nested in the chooser", async ({
    page,
  }) => {
    const sidebar = new DataSelectionSidebar(page);
    await expect(sidebar.filesContainer).toHaveCount(1);
    await expect(sidebar.filesContainer).toHaveClass(
      /js-file-settings-section/,
    );
    await expect(sidebar.tablesContainer).toHaveCount(1);
    await expect(sidebar.tablesContainer).toHaveClass(
      /js-database-settings-section/,
    );
  });

  test("reaching through the containers still lands on the panes' own controls", async ({
    page,
  }) => {
    const sidebar = new DataSelectionSidebar(page);
    for (const name of [
      "backuproot",
      "backupcontent",
      "backupplugins",
      "backupthemes",
      "backupuploads",
    ]) {
      await expect(
        sidebar.filesContainer.locator(`[name="${name}"]`),
        `file-area switch ${name}`,
      ).toHaveCount(1);
    }
    await expect(sidebar.extraFolders).toHaveCount(1);
    await expect(sidebar.excludedFiles).toHaveCount(1);
    await expect(
      sidebar.filesContainer.locator("#file-exclusions-submit"),
    ).toHaveCount(1);
    await expect(sidebar.tableList).toHaveCount(1);
    await expect(
      sidebar.tablesContainer.locator("#save-excluded-tables"),
    ).toHaveCount(1);
    expect(await sidebar.tableCheckboxes.count()).toBeGreaterThan(0);
  });

  test("the chooser's gear is a different element from the pane's back arrow", async ({
    page,
  }) => {
    // Why `openFilesPane` scopes to `.js-data-main-setting`: unscoped, the attribute matches both the
    // gear that opens the pane and the arrow inside it that closes it again, so `.first()` could pick
    // the wrong one and toggle straight back.
    for (const which of ["files", "database"]) {
      await expect(
        page.locator(`[data-toggle-setting-panel="${which}"]`),
        `unscoped ${which} toggle`,
      ).toHaveCount(2);
      await expect(
        page.locator(
          `#sidebar-settings-data-type .js-data-main-setting [data-toggle-setting-panel="${which}"]`,
        ),
        `scoped ${which} gear`,
      ).toHaveCount(1);
    }
  });

  test("both panes ship behind the chooser, carrying the `hidden` class", async ({
    page,
  }) => {
    // Static markup, so `hidden` has no rendering effect here — but its *presence* is what the gear
    // toggles, and it is why `waitForFilesLoaded` needs a visibility check on the live page.
    await expect(
      page.locator("#sidebar-settings-data-type .js-data-main-setting"),
    ).toHaveCount(1);
    for (const pane of [
      "js-file-settings-section",
      "js-database-settings-section",
    ]) {
      await expect(
        page.locator(`#sidebar-settings-data-type .${pane}.hidden`),
        `${pane} ships hidden`,
      ).toHaveCount(1);
    }
  });

  test("the storage picker is populated, with every provider panel", async ({
    page,
  }) => {
    const sidebar = new StorageSidebar(page);
    await expect(sidebar.container).toHaveCount(1);
    expect(await sidebar.container.locator("*").count()).toBeGreaterThan(0);
    for (const slug of ALL_STORAGES) {
      await expect(sidebar.panel(slug), `panel for ${slug}`).toHaveCount(1);
      await expect(
        sidebar.panel(slug).locator(`.js-backwpup-test-${slug}-storage`),
        `save-and-test trigger for ${slug}`,
      ).toHaveCount(1);
    }
  });

  test("a picker tile splits into a select button and a separate gear", async ({
    page,
  }) => {
    // The dashboard uses `storage-item.php`: the checkbox lives in `js-backwpup-select-storage`, and
    // `js-backwpup-toggle-storage` is the *gear* beside it. Onboarding uses `onboarding/storage-item.php`,
    // where one button is both. So `StorageSidebar.storageToggle` resolves to the gear here — which is
    // right for `openSettings`, and is why selecting a destination is not the same click on the two screens.
    const sidebar = new StorageSidebar(page);
    await expect(sidebar.storageToggle("FOLDER")).toHaveCount(1);
    await expect(
      sidebar.storageToggle("FOLDER").locator("#destination-FOLDER"),
      "the gear must NOT contain the checkbox on this screen",
    ).toHaveCount(0);
    await expect(
      page.locator(
        '#sidebar-storages .js-backwpup-select-storage[data-storage="FOLDER"] #destination-FOLDER',
      ),
      "the checkbox lives in the select button instead",
    ).toHaveCount(1);
  });

  test("a panel fetched through the picker gains 'Back to Storages'", async ({
    page,
  }) => {
    // The one real difference between the two screens' provider panels. `storage-*.php` emits this link
    // only when rendered with `is_in_form === false`, which happens only via `load_and_open_storage`.
    // FTP is the panel this capture opened through the picker; the rest are merely pre-rendered, so
    // this doubles as proof that the difference tracks *how the panel was loaded*, not which screen.
    await expect(
      page.locator('#sidebar-storage-FTP [data-content="storages"]'),
    ).toHaveCount(1);
    await expect(
      page.locator('#sidebar-storage-S3 [data-content="storages"]'),
      "a pre-rendered panel has no back link",
    ).toHaveCount(0);
  });

  test("Frequency: the job screen DOES offer 'Triggered by link'", async ({
    page,
  }) => {
    const sidebar = new FrequencySidebar(page);
    await expect(sidebar.frequencySelect).toHaveCount(1);
    const values = await sidebar.frequencySelect
      .locator("option")
      .evaluateAll((options) =>
        options.map((option) => (option as HTMLOptionElement).value),
      );
    expect(values).toEqual(["hourly", "daily", "weekly", "monthly", "link"]);
    await expect(sidebar.container.locator("#save-job-settings")).toHaveCount(
      1,
    );
  });

  test("Advanced settings and its sub-panels are populated here", async ({
    page,
  }) => {
    // The mirror image of onboarding's aside: these are the panels onboarding suppresses.
    for (const id of [
      "sidebar-advanced-settings",
      "sidebar-settings-jobs",
      "sidebar-settings-logs",
      "sidebar-settings-network",
    ]) {
      expect(
        await page.locator(`#${id}`).locator("*").count(),
        `${id} is populated on a job screen`,
      ).toBeGreaterThan(0);
    }
  });

  test("Delete Backup modal and the backup log modal resolve", async ({
    page,
  }) => {
    await expect(page.locator("#sidebar-delete-backup")).toHaveCount(1);
    await expect(page.locator("#sidebar-backup-log")).toHaveCount(1);
  });

  test("the bulk delete confirmation resolves, with the button the POM clicks", async ({
    page,
  }) => {
    // Pressing "Apply" issues no request at all: its handler stores the selection and opens this
    // dialog, and the `process_bulk_actions` call happens only when this button is pressed
    // (`backwpup-admin.js`, the `action === 'delete'` branch). So this modal is what the POM waits
    // for, and this button is what completes the action.
    const table = new BackupHistoryTable(page);
    await expect(table.bulkDeleteModal).toHaveCount(1);
    await expect(
      table.bulkDeleteModal.getByRole("button", { name: "Delete Backups" }),
    ).toHaveCount(1);
    await expect(
      table.bulkDeleteModal.locator(".js-backwpup-bulk-delete-backups"),
    ).toHaveCount(1);
  });
});

test.describe("Strict-mode guard — every click target resolves to exactly one element", () => {
  /**
   * Playwright refuses to act on a locator that matches more than one element, so an ambiguous
   * click-target is a runtime failure, not a style problem — and it is invisible until the click runs.
   * This audits the ambiguity directly against the captured markup.
   *
   * It exists because a real instance shipped: the dashboard emits `id="js_backwpup_add_new_backup"`
   * **twice** (once visibly, once in a hidden clone template), so the obvious id lookup matched two
   * elements. The last case below pins that, and would fail again if the scoping were removed.
   */
  const cases: readonly [fixture: string, label: string, selector: string][] = [
    // Onboarding: each pane's own navigation triggers. The classes repeat across panes, so the
    // per-pane scoping is what keeps them unambiguous.
    [
      "onboarding.html",
      "step 1 → 2",
      '#backwpup-onboarding-panes article[data-step="1"] .js-backwpup-onboarding-step-2',
    ],
    [
      "onboarding.html",
      "step 2 → 3",
      '#backwpup-onboarding-panes article[data-step="2"] .js-backwpup-onboarding-step-3',
    ],
    [
      "onboarding.html",
      "step 2 → 1",
      '#backwpup-onboarding-panes article[data-step="2"] .js-backwpup-onboarding-step-1',
    ],
    [
      "onboarding.html",
      "step 3 → 2",
      '#backwpup-onboarding-panes article[data-step="3"] .js-backwpup-onboarding-step-2',
    ],
    [
      "onboarding.html",
      "onboarding submit",
      "#backwpup-onboarding-panes .js-backwpup-onboarding-submit-form",
    ],
    [
      "onboarding.html",
      "files exclusions trigger",
      '#backwpup-onboarding-panes article[data-step="1"] .js-backwpup-load-and-open-sidebar[data-content="select-files"]',
    ],
    [
      "onboarding.html",
      "tables exclusions trigger",
      '#backwpup-onboarding-panes article[data-step="1"] .js-backwpup-load-and-open-sidebar[data-content="select-tables"]',
    ],
    // Dashboard header + history controls.
    [
      "dashboard.html",
      "Backup Now",
      '.js-backwpup-open-modal[data-content="backup-now"]',
    ],
    ["dashboard.html", "bulk Apply", "#bulk-actions-apply"],
    [
      "dashboard.html",
      "select-all",
      "#backwpup-backup-history .js-backwpup-select-all",
    ],
    ["dashboard.html", "Display Logs", "#runningjob a.thickbox"],
    ["dashboard.html", "abort", "#abortbutton"],
    ["dashboard.html", "close running job", "#showworkingclose"],
    // Sidebar submits.
    [
      "sidebars-onboarding.html",
      "Backup Now → Start",
      "#sidebar-backup-now .js-backwpup-start-backup-now",
    ],
    // Scoped to the onboarding capture on purpose: on a job screen these two articles are empty shells and
    // the same submits live inside `#sidebar-settings-data-type` instead.
    [
      "sidebars-onboarding.html",
      "files exclusions save",
      "#sidebar-select-files #file-exclusions-submit",
    ],
    [
      "sidebars-onboarding.html",
      "tables save",
      "#sidebar-select-tables #save-excluded-tables",
    ],
    [
      "sidebars-dashboard.html",
      "files exclusions save (job screen)",
      "#sidebar-settings-data-type .js-file-settings-section #file-exclusions-submit",
    ],
    [
      "sidebars-dashboard.html",
      "tables save (job screen)",
      "#sidebar-settings-data-type .js-database-settings-section #save-excluded-tables",
    ],
    // The regression this guard was written for.
    [
      "dashboard.html",
      "add-backup card (scoped)",
      "#backwup-next-scheduled-backups #js_backwpup_add_new_backup",
    ],
  ];

  for (const [fixtureName, label, selector] of cases) {
    test(`${label} (${fixtureName})`, async ({ page }) => {
      await renderFixture(page, fixture(fixtureName));
      await expect(page.locator(selector), label).toHaveCount(1);
    });
  }

  test("the add-backup id really is duplicated, so the scoping is load-bearing", async ({
    page,
  }) => {
    // If this ever drops to 1, the plugin fixed its duplicate id and the scoping could be relaxed.
    await renderFixture(page, DASHBOARD);
    await expect(page.locator("#js_backwpup_add_new_backup")).toHaveCount(2);
  });
});

test.describe("Storage panel titles — a verified map, not a derived string", () => {
  test("each panel's heading matches STORAGE_PANEL_TITLES", async ({
    page,
  }) => {
    await renderFixture(page, SIDEBARS_DASHBOARD);
    const sidebar = new StorageSidebar(page);
    // All eleven, since the capture carries every panel.
    //
    // Asserted on the `<h1>` rather than through `getByRole("heading")` **on purpose**: the capture
    // preserves the inline `display: none` the plugin's own `openSidebar()` puts on every article it
    // is not showing, and a `display: none` subtree is absent from the accessibility tree — so a role
    // locator resolves to nothing for ten of the eleven. `StorageSidebar.openSettings` may keep using
    // the role locator because it only ever runs against the panel that is actually open.
    for (const slug of ALL_STORAGES) {
      const heading = sidebar.panel(slug).locator("h1");
      await expect(heading, `one heading for ${slug}`).toHaveCount(1);
      await expect(heading, `panel heading for ${slug}`).toHaveText(
        STORAGE_PANEL_TITLES[slug],
      );
    }
  });

  test("FOLDER's panel title differs from its picker label — the reason the map exists", () => {
    // "Website Server" in the picker, "Folder Settings" on the panel. Deriving one from the other
    // was a real bug: openSettings("FOLDER") asserted a heading that never existed.
    expect(STORAGE_PANEL_TITLES.FOLDER).toBe("Folder Settings");
    expect(STORAGE_PANEL_TITLES.FOLDER).not.toBe(
      `${STORAGE_LABELS.FOLDER} Settings`,
    );
  });

  test("every other destination's title is its label plus ' Settings'", () => {
    // Documents that FOLDER is the sole exception, so a future divergence is caught here.
    for (const slug of ALL_STORAGES.filter((s) => s !== "FOLDER")) {
      expect(STORAGE_PANEL_TITLES[slug], slug).toBe(
        `${STORAGE_LABELS[slug]} Settings`,
      );
    }
  });
});

test.describe("Restore modal — the confirm button's real label", () => {
  test("the modal confirms with 'Start Restoration'", async ({ page }) => {
    await renderFixture(page, SIDEBARS_DASHBOARD);
    const modal = page.locator("#sidebar-restore-backup");
    await expect(modal).toHaveCount(1);
    await expect(
      modal.getByRole("button", { name: "Start Restoration" }),
    ).toHaveCount(1);
  });

  test("a /Restore/ pattern matches nothing — the trap this replaced", async ({
    page,
  }) => {
    // "Start Restoration" does not contain the substring "Restore", so the obvious regex silently
    // matched zero elements and the restore flow timed out instead of failing clearly.
    await renderFixture(page, SIDEBARS_DASHBOARD);
    await expect(
      page.locator("#sidebar-restore-backup").getByRole("button", {
        name: /Restore/,
      }),
    ).toHaveCount(0);
  });

  test("the delete modals confirm with the labels confirmDelete matches", async ({
    page,
  }) => {
    await renderFixture(page, SIDEBARS_DASHBOARD);
    await expect(
      page
        .locator("#sidebar-delete-backup")
        .getByRole("button", { name: /^Delete (Backup|Entry)$/ }),
    ).toHaveCount(1);
    await expect(
      page
        .locator("#sidebar-delete-failed-backup")
        .getByRole("button", { name: /^Delete (Backup|Entry)$/ }),
    ).toHaveCount(1);
  });
});

test.describe("FirstBackupPage — locator contract", () => {
  test.beforeEach(async ({ page }) => {
    await renderFixture(page, FIRST_BACKUP);
  });

  // The **only** place these two markers are asserted. The page object deliberately does not check
  // them on the live page: the plugin may navigate away from this screen on its own the moment the
  // first backup finishes, so a retrying DOM assertion there races a correct behaviour (see
  // `FirstBackupPage`). A captured fixture has no clock, so it can hold them honestly.
  test("the page's heading and its job-id field resolve", async ({ page }) => {
    await expect(
      page
        .getByRole("heading", { name: "We are creating a backup of your site" })
        .first(),
    ).toBeVisible();
    await expect(page.locator("#backwpup_first_backup_job_id")).toBeAttached();
  });

  // The reason the assertion above takes `.first()`: the progress box titles itself with the page's
  // own heading, so a running job puts two matching headings on screen. Here the box is still
  // hidden, so only one is in the accessibility tree — which is exactly how the trap stays invisible
  // until the day a scenario is a little slower.
  test("the progress box reuses the page heading, so two exist in the markup", async ({
    page,
  }) => {
    await expect(
      page.locator("h1", { hasText: "We are creating a backup of your site" }),
    ).toHaveCount(2);
    await expect(
      page.locator("#runningjob #backupgeneration-progress-box-title"),
    ).toHaveCount(1);
  });

  test("the congratulations panel is present but hidden while the job runs", async ({
    page,
  }) => {
    const firstBackup = new FirstBackupPage(page);
    await expect(firstBackup.congratulations).toHaveCount(1);
    // Presence proves nothing here — the template ships it with an inline `display: none` and the
    // progress poller reveals it. This is what makes a wait on it a wait on the plugin's JavaScript.
    await expect(firstBackup.congratulations).toBeHidden();
  });

  // The other half of that story, and the reason the completion signal moved to WP-CLI: this page
  // is only reached once, and re-posting `startbackup` for the same first backup is answered with a
  // redirect to the dashboard — so a fast backup never reveals the panel above at all.
  test("the progress region ships hidden too, revealed only while a job runs", async ({
    page,
  }) => {
    await expect(page.locator("#runningjob")).toHaveCount(1);
    await expect(page.locator("#runningjob")).toBeHidden();
  });
});
