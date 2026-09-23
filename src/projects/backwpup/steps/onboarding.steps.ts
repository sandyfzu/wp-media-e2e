import { expect } from "@playwright/test";
import type { DataTable } from "playwright-bdd";

import { Given, Then, When } from "../fixtures";
import {
  allowForBackup,
  countBackups,
  listJobs,
  waitForBackup,
} from "../support/backups";
import {
  ONBOARDING_OPTION,
  finishActivation,
  isOnboardingPending,
  readOnboardingFlag,
  reinstallPlugin,
} from "../support/onboarding";
import {
  FILE_AREAS,
  describeJobContents,
  readStoredJobs,
  scheduledJobs,
  theScheduledJob,
} from "../support/job-options";
import type { FileArea } from "../support/job-options";
import { LOCAL_STORAGE, storageForLabel } from "../pages/storages";
import { isPluginActive } from "../../../common/wp/plugin";
import { tablePrefix } from "../../../common/wp/db";
import type { BasicFrequency } from "../pages/frequency.sidebar";
import type { DashboardPage, JobDataType } from "../pages/dashboard.page";
import type { Transport } from "../../../common/config/types";

/**
 * Steps for BackWPup's onboarding.
 *
 * Two conventions run through the file and are worth stating once:
 *
 *  - **Assertion steps open what they need and put it back.** Several checks live behind a sidebar
 *    (which file areas are included, which tables are), so a `Then` here may open a panel and close
 *    it again. It changes nothing — reading a panel is not editing it — and it keeps each step
 *    self-contained rather than forcing the feature file to narrate panel plumbing.
 *  - **Outcomes are asserted from two sources wherever both can answer.** What the browser shows
 *    comes from the page objects; what the site actually stored comes from WP-CLI (`wp backwpup
 *    job`, and the job option itself for the settings that command does not expose). A screen
 *    rendering the right thing over the wrong state is precisely the failure a DOM-only assertion
 *    cannot see — and a stored value nobody can see is not a feature either.
 */

/** Narrows a scenario's word for a data type to what onboarding's switches accept. */
function dataType(value: string): "files" | "database" {
  if (value === "files" || value === "database") return value;
  throw new Error(
    `[backwpup/onboarding] unknown backup data type "${value}". Use "files" or "database".`,
  );
}

/** Narrows a scenario's word for a file area to one the plugin actually offers. */
function fileArea(value: string): FileArea {
  const area = FILE_AREAS.find((candidate) => candidate === value);
  if (area === undefined) {
    throw new Error(
      `[backwpup/onboarding] unknown file area "${value}". Use one of: ${FILE_AREAS.join(", ")}.`,
    );
  }
  return area;
}

/** Narrows a scenario's word for a job card into the type the card advertises in its own class. */
function jobCardType(value: string): JobDataType {
  if (value === "mixed" || value === "files" || value === "database") {
    return value;
  }
  throw new Error(
    `[backwpup/onboarding] unknown job card type "${value}". Use mixed, files or database.`,
  );
}

/**
 * Narrows a scenario's word for a schedule.
 *
 * `link` is deliberately unreachable here: onboarding's dropdowns offer only the four intervals,
 * and the link-triggered option appears once onboarding is over.
 */
function frequency(value: string): BasicFrequency {
  const allowed: readonly BasicFrequency[] = [
    "hourly",
    "daily",
    "weekly",
    "monthly",
  ];
  const found = allowed.find((candidate) => candidate === value);
  if (found === undefined) {
    throw new Error(
      `[backwpup/onboarding] unknown frequency "${value}". Onboarding offers: ${allowed.join(", ")}.`,
    );
  }
  return found;
}

/** A table's full name on this site — scenarios name tables without the install's prefix. */
async function prefixedTable(
  transport: Transport,
  table: string,
): Promise<string> {
  return `${await tablePrefix(transport)}${table}`;
}

// ── Starting state ───────────────────────────────────────────────────────────

/**
 * The site as the plugin lifecycle hook has just left it: the edition under test, freshly installed,
 * active, and owing its onboarding.
 *
 * **It does not count jobs**, the tempting check, because a job count is not a property of a fresh
 * install. Activation creates a placeholder job of its own, and rendering the onboarding page
 * creates two more, so "no jobs" is only ever true in the window before the plugin has
 * bootstrapped. Worse, it is not even guaranteed *between* scenarios: BackWPup's `uninstall.php`
 * wraps its entire database cleanup in `! class_exists( \BackWPup::class )`, so the footprint is only
 * removed when nothing loaded the class during that request — which made this an intermittent
 * failure that blamed whichever scenario ran next.
 *
 * It takes the plugin's own verdict instead: its activation routine has run and left the site owing
 * its onboarding — redone from a clean install when another request raced it, see
 * {@link finishActivation} — before anything else, a browser or a WP-CLI command under test, is let
 * near it.
 */
Given(
  "a freshly installed BackWPup",
  async ({ site, pluginArtifact, $testInfo }) => {
    const artifact = pluginArtifact("plugin");
    expect(
      await isPluginActive(site.transport, artifact.slug),
      `the scenario's plugin ("${artifact.slug}") should have been installed and activated by the @plugin hook`,
    ).toBe(true);
    await finishActivation(
      site.transport,
      reinstallPlugin(site.transport, artifact, $testInfo),
    );
  },
);

When("I open the BackWPup dashboard", async ({ dashboard }) => {
  await dashboard.goto();
});

/**
 * The redirect that makes onboarding unskippable, asserted from both sides.
 *
 * While the flag is set, every BackWPup screen except a small allow-list is redirected to the
 * onboarding page, and the redirect runs on `admin_init` — after the `init` hook that sets the flag in the
 * first place. So arriving here proves the request completed the plugin's bootstrap, which is what
 * makes reading the flag afterwards a statement about the product rather than a race with it.
 */
Then("I land on the onboarding page instead", async ({ site, onboarding }) => {
  await onboarding.expectAtOnboardingPage();
  await onboarding.expectLoaded();
  const flag = await readOnboardingFlag(site.transport);
  expect(
    isOnboardingPending(flag),
    `the site should be flagged for onboarding (${ONBOARDING_OPTION} = ${JSON.stringify(flag)})`,
  ).toBe(true);
});

// ── Step 1: what to back up ──────────────────────────────────────────────────

When(
  "I exclude {string} from the backup",
  async ({ onboarding }, kind: string) => {
    await onboarding.setDataIncluded(dataType(kind), false);
  },
);

When(
  "I include {string} in the backup",
  async ({ onboarding }, kind: string) => {
    await onboarding.setDataIncluded(dataType(kind), true);
  },
);

Then(
  "{string} is included in the backup",
  async ({ onboarding }, kind: string) => {
    await onboarding.expectDataIncluded(dataType(kind), true);
  },
);

Then(
  "{string} is not included in the backup",
  async ({ onboarding }, kind: string) => {
    await onboarding.expectDataIncluded(dataType(kind), false);
  },
);

Then(
  "every file area is included in the backup",
  async ({ onboarding, dataSelection }) => {
    await onboarding.openDataSelection("files");
    await dataSelection.waitForFilesLoaded();
    await dataSelection.expectAllFileAreasIncluded();
    await dataSelection.close("files");
  },
);

/**
 * The default table selection, asserted as the plugin's actual rule rather than "everything is
 * ticked": a new job includes every table belonging to this install and excludes any other table
 * sharing the database. Reading the prefix from the site is what makes the second half meaningful.
 */
Then(
  "every table of this WordPress install is included in the backup",
  async ({ site, onboarding, dataSelection }) => {
    const prefix = await tablePrefix(site.transport);
    await onboarding.openDataSelection("database");
    await dataSelection.waitForTablesLoaded();
    await dataSelection.expectDefaultTableSelection(prefix);
    await dataSelection.close("tables");
  },
);

When(
  "I exclude the {string} file area from the backup",
  async ({ onboarding, dataSelection }, area: string) => {
    await onboarding.openDataSelection("files");
    await dataSelection.waitForFilesLoaded();
    await dataSelection.setFileAreaIncluded(fileArea(area), false);
    await dataSelection.saveFiles();
    await dataSelection.expectClosed("files");
  },
);

When(
  "I exclude the {string} database table from the backup",
  async ({ site, onboarding, dataSelection }, table: string) => {
    const name = await prefixedTable(site.transport, table);
    await onboarding.openDataSelection("database");
    await dataSelection.waitForTablesLoaded();
    await dataSelection.setTableIncluded(name, false);
    await dataSelection.saveTables();
    await dataSelection.expectClosed("tables");
  },
);

Then("onboarding will not leave the data step", async ({ onboarding }) => {
  await onboarding.expectCanContinueToSchedule(false);
});

Then("onboarding will leave the data step", async ({ onboarding }) => {
  await onboarding.expectCanContinueToSchedule(true);
});

// ── Step 2: when to back up ──────────────────────────────────────────────────

When("I continue to the schedule step", async ({ onboarding }) => {
  await onboarding.continueToSchedule();
});

When("I go back to the data step", async ({ onboarding }) => {
  await onboarding.backToDataSelection();
});

When("I go back to the schedule step", async ({ onboarding }) => {
  await onboarding.backToSchedule();
});

When(
  "I schedule the {string} backup {string}",
  async ({ onboarding }, kind: string, interval: string) => {
    await onboarding.setFrequency(dataType(kind), frequency(interval));
  },
);

/**
 * What the onboarding form *shows*, as opposed to what the site has stored — nothing is saved until
 * onboarding is submitted, so this is the assertion for "stepping back did not lose my choice".
 */
Then(
  "the onboarding page still has the {string} backup set to {string}",
  async ({ onboarding }, kind: string, interval: string) => {
    await onboarding.expectFrequency(dataType(kind), frequency(interval));
  },
);

/**
 * The same choice made through the sidebar rather than the inline dropdown.
 *
 * The two are not interchangeable under the hood: the dropdown is only submitted with the form and
 * turned into a schedule at the end, whereas saving here writes the job's `cron` and `frequency`
 * immediately (`save_job_settings`) — and onboarding then keeps that cron rather than recomputing
 * one.
 *
 * The stored `frequency` survives too, but only via a step the plugin takes on the client: on a
 * successful save the admin script copies the sidebar's value into this job's inline dropdown
 * (`backwpup-admin.js`, "Sync onboarding frequency dropdown"), and it is that dropdown the form
 * submits — step 2 renders it with a hard-coded `monthly`, so without the sync the submit would
 * write `monthly` over the choice made here. Asserting each job's frequency afterwards is therefore
 * also the only coverage that sync has.
 */
When(
  "I schedule the {string} backup {string} through the advanced settings",
  async (
    { onboarding, frequency: sidebar },
    kind: string,
    interval: string,
  ) => {
    await onboarding.openAdvancedFrequency(dataType(kind));
    await sidebar.waitForLoaded();
    await sidebar.setFrequency(frequency(interval));
    await sidebar.save();
  },
);

// ── Step 3: where to store it ────────────────────────────────────────────────

When("I continue to the storage step", async ({ onboarding }) => {
  await onboarding.continueToStorage();
});

When("I store backups on the website server", async ({ onboarding }) => {
  await onboarding.selectStorage(LOCAL_STORAGE);
});

Then("onboarding cannot be completed yet", async ({ onboarding }) => {
  await onboarding.expectCanSubmit(false);
});

Then("onboarding can be completed", async ({ onboarding }) => {
  await onboarding.expectCanSubmit(true);
});

// ── Completing onboarding ────────────────────────────────────────────────────

/**
 * Submits onboarding and confirms the plugin handed over to its first-backup flow.
 *
 * One step rather than two, because the order is load-bearing: the handover must be *watched for*
 * before the click, not checked afterwards. The plugin can legitimately move the browser off that
 * screen moments later — see `FirstBackupPage` — and a check made after the fact races it.
 */
When("I complete onboarding", async ({ onboarding, firstBackup }) => {
  await firstBackup.expectHandover(() => onboarding.submit());
});

/**
 * Waits for the backup onboarding started on save.
 *
 * Not optional politeness: the dashboard re-renders its job cards while a job runs, so assertions
 * made mid-run race a moving page — and the plugin lifecycle uninstalls the plugin when the
 * scenario ends, which a background job must not outlive.
 *
 * **Watched through WP-CLI rather than through the page**, because the first-backup screen cannot
 * answer the question: it only congratulates the user when the run was still going as the page
 * reloaded, and a fast backup instead gets redirected straight to the dashboard (see
 * `FirstBackupPage.congratulations`). The archive landing in the history is true either way.
 *
 * Two waits, in this order and for different reasons: the archive is what "the backup happened"
 * means, and the job then has a little finalising left to do — so the blocking status check
 * afterwards is what guarantees nothing is still running when the plugin is uninstalled. Doing it
 * the other way round would put the process-level wait first, where it can answer "nothing is
 * running" before the job has even registered itself.
 */
Then("the first backup completes", async ({ site, $testInfo }) => {
  // Playwright times a scenario and its hooks against one clock, so make room before spending any
  // of the budget.
  allowForBackup($testInfo);
  expect(
    await waitForBackup(site.transport, 0),
    "the first backup should not have ended in errors",
  ).not.toBe("errors");
});

/**
 * The archive count, from the plugin's own tally.
 *
 * The counterpart to the step above: the first-backup screen congratulates the user whether the run
 * succeeded or failed, so an archive actually existing is what proves it worked.
 */
Then(
  "the site has {int} stored backup(s)",
  async ({ site }, expected: number) => {
    expect(
      await countBackups(site.transport),
      "stored backups after onboarding",
    ).toBe(expected);
  },
);

// ── What onboarding produced ─────────────────────────────────────────────────

/**
 * The full set of scheduled jobs, compared against `wp backwpup job` — count included.
 *
 * Matched as an unordered multiset: which job id ends up first is the plugin's business, while
 * "these are the jobs that exist" is the claim worth pinning. Contents are compared by their
 * meaning rather than by the slug string the command prints, so a reordering of `FILE, DBDUMP,
 * WPPLUGIN` cannot fail a scenario, and a genuinely different mixture reads as such in the diff.
 */
Then("the scheduled backup jobs are:", async ({ site }, table: DataTable) => {
  const expected = table.hashes().map((row) => {
    const label = row.storage ?? "";
    const slug = storageForLabel(label);
    if (slug === undefined) {
      throw new Error(
        `[backwpup/onboarding] unknown storage "${label}" in the scenario's table.`,
      );
    }
    return { contents: row.contents ?? "", storages: slug };
  });

  const jobs = await listJobs(site.transport);
  const actual = jobs.map((job) => ({
    contents: describeJobContents(job.type.split(",")),
    storages: job.storages
      .split(",")
      .map((slug) => slug.trim().toUpperCase())
      .filter((slug) => slug !== "")
      .join(", "),
  }));

  const key = (row: { contents: string; storages: string }): string =>
    `${row.contents} → ${row.storages}`;
  expect(
    actual.map(key).sort(),
    "the backup jobs onboarding configured",
  ).toEqual(expected.map(key).sort());
});

Then(
  "the {string} backup job runs {string}",
  async ({ site }, contents: string, interval: string) => {
    const jobs = scheduledJobs(await readStoredJobs(site.transport));
    const job = jobs.find(
      (candidate) => describeJobContents(candidate.type) === contents,
    );
    expect(job, `a scheduled job covering "${contents}"`).toBeDefined();
    expect(job?.frequency, `the "${contents}" job's schedule`).toBe(
      frequency(interval),
    );
  },
);

/**
 * That the two jobs are scheduled apart — which is the *reason* they are two jobs at all.
 *
 * Onboarding's split is decided on the cron expression, not on the frequency: `save_post_form`
 * merges files and the database into one `mixed` job when both are active **and**
 * `$files_cron_value === $db_cron_value` (`class-page-onboarding.php`). So this asserts the
 * precondition of the two-job outcome, where `the scheduled backup jobs are:` asserts the outcome
 * itself — not the same fact twice.
 *
 * It earns its place mainly in the advanced-settings path, where the cron is **not** derivable from
 * the frequency. Reaching step 2 through the sidebar writes the job's cron before onboarding is
 * submitted, and `get_onboarding_job_cron` then keeps a cron it finds already stored rather than
 * recomputing one — with the sidebar's start time folded in. Through the inline dropdowns no job
 * record exists yet, so the cron is derived from the chosen frequency and "files weekly / database
 * daily" already *is* the cron difference in the user's words.
 *
 * Deliberately "they differ" rather than two exact expressions: pinning the strings would assert
 * BackWPup's cron formatting. That is also why it is asserted **alongside** each job's own
 * frequency rather than instead of it — cron inequality alone cannot tell a correct split from one
 * where the two schedules were applied to the wrong jobs.
 */
Then("the two backup jobs run on different schedules", async ({ site }) => {
  const jobs = scheduledJobs(await readStoredJobs(site.transport));
  expect(jobs, "scheduled backup jobs").toHaveLength(2);
  const [first, second] = jobs;
  expect(first?.cron, "the first job's cron expression").not.toBe("");
  expect(
    second?.cron,
    "the two jobs must not share a schedule — sharing one is what merges them into a single job",
  ).not.toBe(first?.cron);
});

Then(
  "the dashboard shows {int} {string} backup job card(s)",
  async ({ dashboard }, count: number, kind: string) => {
    await dashboard.expectLoaded();
    await expect(
      dashboard.jobCardsOfType(jobCardType(kind)),
      `"${kind}" job cards on the dashboard`,
    ).toHaveCount(count);
  },
);

Then(
  "the dashboard shows {int} backup job card(s) in total",
  async ({ dashboard }, count: number) => {
    await dashboard.expectLoaded();
    await expect(dashboard.jobCards, "job cards on the dashboard").toHaveCount(
      count,
    );
  },
);

// ── That the data selection survived ─────────────────────────────────────────

Then(
  "the scheduled backup job excludes the {string} file area",
  async ({ site }, area: string) => {
    const job = await theScheduledJob(site.transport);
    expect(
      job.includedAreas[fileArea(area)],
      `the "${area}" file area on the job onboarding created`,
    ).toBe(false);
  },
);

/**
 * Opens the data-selection chooser on the scheduled job's card.
 *
 * Shared by the two steps below so each stays usable on its own: a scenario may assert either
 * exclusion without the other, and neither may depend on a panel a previous step left open.
 */
async function openScheduledJobDataSelection(
  transport: Transport,
  dashboard: DashboardPage,
): Promise<void> {
  const job = await theScheduledJob(transport);
  await dashboard.openJobSidebar(job.jobId, "Data");
}

/**
 * The two exclusions re-read from the job card's own panels, alongside the stored-job checks above.
 *
 * Both are kept deliberately: one asks the site what it stored, the other asks the screen what it
 * shows. A configuration saved but never rendered back is as broken as one rendered but never
 * saved, and only having both can tell the two apart.
 */
Then(
  "the job card still shows the {string} file area excluded",
  async ({ site, dashboard, dataSelection }, area: string) => {
    await openScheduledJobDataSelection(site.transport, dashboard);
    await dataSelection.openFilesPane();
    await dataSelection.expectFileAreaIncluded(fileArea(area), false);
  },
);

/** The database half of the pair above; the table is named without this install's prefix. */
Then(
  "the job card still shows the {string} database table excluded",
  async ({ site, dashboard, dataSelection }, table: string) => {
    const name = await prefixedTable(site.transport, table);
    await openScheduledJobDataSelection(site.transport, dashboard);
    // `openTablesPane` ends in `waitForTablesLoaded`, so the panel is ready to read here.
    await dataSelection.openTablesPane();
    await dataSelection.expectTableIncluded(name, false);
  },
);

Then(
  "the scheduled backup job excludes the {string} database table",
  async ({ site }, table: string) => {
    const name = await prefixedTable(site.transport, table);
    const job = await theScheduledJob(site.transport);
    expect(job.excludedTables, "tables kept out of the dump").toContain(name);
  },
);
