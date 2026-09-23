import { createHash } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { pipeline } from "node:stream/promises";

import { expect } from "@playwright/test";

import { Given, Then, When } from "../fixtures";
import {
  allowForBackup,
  countBackups,
  listBackups,
  runScheduledBackup,
  waitForBackup,
} from "../support/backups";
import {
  CRON_HOOK,
  completeOnboarding,
  reinstallPlugin,
} from "../support/onboarding";
import { theScheduledJob } from "../support/job-options";
import { nextScheduled, triggerScheduledEvent } from "../../../common/wp/cron";
import { fileChecksum } from "../../../common/wp/files";
import type { JobContents } from "../support/job-options";

/**
 * Steps for making backups and for what a user can do with the ones already made.
 *
 * Three conventions run through the file:
 *
 *  - **The site is set up by WP-CLI, not by driving onboarding.** Onboarding has a feature file of
 *    its own, and it costs a full backup of the site every time it is submitted; a scenario about
 *    the *history* has no business paying that. `completeOnboarding` produces the state a real
 *    onboarding leaves, verified field by field against one.
 *  - **A step that starts a backup also waits for it.** "I backed up" is not true until the run is
 *    over, and leaving the wait to a separate step would need the archive count from before the run
 *    to be carried between steps. Waiting where the run starts keeps every step self-contained and
 *    every assertion afterwards absolute.
 *  - **Counts are asserted from both sides.** What the table renders comes from the page object;
 *    what the site actually holds comes from `wp backwpup backup`. A table that renders a row for
 *    an archive that is gone — or hides one that is not — is exactly what a DOM-only assertion
 *    cannot see.
 */

/** Narrows a scenario's word for what a backup job covers. */
function jobContents(value: string): JobContents {
  if (
    value === "files" ||
    value === "database" ||
    value === "files and database"
  ) {
    return value;
  }
  throw new Error(
    `[backwpup/backups] unknown backup contents "${value}". Use files, database, or files and database.`,
  );
}

// ── Starting state ───────────────────────────────────────────────────────────

/**
 * A site that is already set up — past onboarding, with one scheduled job.
 *
 * Says what the site *is*, not how it got there, because how it got there is not this feature's
 * subject. The contents are named because they are visible in everything that follows: the job
 * card the dashboard renders, and what each archive contains.
 */
Given(
  "BackWPup is set up to back up the {string} on a schedule",
  async ({ site, pluginArtifact, $testInfo }, contents: string) => {
    await completeOnboarding(
      site.transport,
      jobContents(contents),
      reinstallPlugin(site.transport, pluginArtifact("plugin"), $testInfo),
    );
  },
);

/**
 * Backups that already exist when the scenario begins.
 *
 * Made by running the site's own scheduled job through WP-CLI rather than through the dashboard —
 * arranging a precondition must not depend on the controls a scenario is about to test, or a
 * broken control would fail the scenario in its `Given` and say nothing useful about why.
 */
Given(
  "the site has already made {int} backup(s)",
  async ({ site, $testInfo }, count: number) => {
    allowForBackup($testInfo, count);
    for (let made = 0; made < count; made++) {
      await runScheduledBackup(site.transport);
    }
    expect(
      await countBackups(site.transport),
      "archives arranged before the scenario starts",
    ).toBe(count);
  },
);

// ── Making a backup ──────────────────────────────────────────────────────────

/**
 * The dashboard's own "Backup Now", from opening the confirmation to the run being over.
 *
 * The confirmation and the start are separate page-object calls on purpose — one opens a dialog,
 * the other is the point of no return — and this step is where they belong together, because a
 * user pressing "Backup Now" means both.
 */
When("I back up now", async ({ site, dashboard, jobRun, $testInfo }) => {
  allowForBackup($testInfo);
  const before = await countBackups(site.transport);
  await dashboard.openBackupNow();
  await jobRun.startFromModal();
  expect(
    await waitForBackup(site.transport, before),
    "a backup started from the dashboard should not have ended in errors",
  ).not.toBe("errors");
});

/**
 * That the job has a WP-Cron event of its own — the thing "scheduled" actually means.
 *
 * Asked of WordPress by hook **and job id**, because BackWPup schedules every job on the one
 * `backwpup_cron` hook: an assertion that names only the hook would pass on some *other* job's
 * schedule, including the hidden placeholder one the plugin keeps.
 */
Then("the backup job is scheduled to run", async ({ site }) => {
  const job = await theScheduledJob(site.transport);
  expect(
    await nextScheduled(site.transport, CRON_HOOK, { arg: job.jobId }),
    `job ${String(job.jobId)} should have a WP-Cron event of its own`,
  ).toBeDefined();
});

/**
 * The inverse: the job has no WP-Cron event, so nothing will ever start it on a schedule.
 *
 * Asked by hook and job id for the same reason as above — the hidden placeholder job can hold an
 * event of its own on that hook, so "no event on the hook" could fail for a reason that has nothing
 * to do with this job.
 */
Then("the backup job is not scheduled to run", async ({ site }) => {
  const job = await theScheduledJob(site.transport);
  expect(
    await nextScheduled(site.transport, CRON_HOOK, { arg: job.jobId }),
    `job ${String(job.jobId)} should have no WP-Cron event`,
  ).toBeUndefined();
});

/**
 * Time reaching the schedule, without waiting out a month of it.
 *
 * The job's own event is brought forward and WordPress is asked to run what is due, so the backup
 * starts the way a scheduled one really starts — inside a web request, through the plugin's cron
 * callback — rather than by calling the code that makes backups. Only this job's event is *moved*;
 * anything the site already had due runs alongside it, as on any real cron tick.
 */
When("its schedule comes due", async ({ site, $testInfo }) => {
  allowForBackup($testInfo);
  const before = await countBackups(site.transport);
  const job = await theScheduledJob(site.transport);
  await triggerScheduledEvent(site.transport, CRON_HOOK, { arg: job.jobId });
  expect(
    await waitForBackup(site.transport, before),
    "a backup started by its schedule should not have ended in errors",
  ).not.toBe("errors");
});

/**
 * That the archive came from the scheduled job and not from somewhere else.
 *
 * Worth its own assertion because the plugin runs several jobs a user never sees — a placeholder
 * job from installation and a throwaway one behind "Backup Now" — each with its own cron event on
 * the same hook. "An archive appeared" would be satisfied by any of them.
 */
Then("the newest backup was made by the scheduled job", async ({ site }) => {
  const job = await theScheduledJob(site.transport);
  const [newest] = await listBackups(site.transport);
  expect(newest, "the newest stored archive").toBeDefined();
  expect(newest?.jobId, "the job that produced the newest archive").toBe(
    job.jobId,
  );
});

// ── The history table ────────────────────────────────────────────────────────

/**
 * The history's row count, asserted against the table **and** against the plugin's own tally.
 *
 * Both sources in one step, because either alone is a weaker claim than it looks: the table can
 * render rows for archives that no longer exist, and the tally can count archives the table never
 * shows. The number comes from the scenario, so neither source can quietly define the answer.
 *
 * **The table is re-read from the server first, and that is load-bearing.** What is on screen is
 * refreshed by the plugin's own client-side poll — `backwpup-generate.js` asks `backwpup_working`
 * every 750 ms and re-fetches the listing only once that reports the job done — so immediately
 * after a backup the rendered table still holds the state from before it, and asserting against it
 * is a race rather than a check. There is no barrier that would fix that in place: whether the
 * refresh happens at all depends on a race inside the plugin (a job that finishes before the page
 * reload it triggers leaves no poll running at all), and both outcomes issue the same `backups`
 * call, so nothing distinguishes the stale fetch from the fresh one. Reading the table back from
 * the server is therefore the only form of this assertion that is not timing-dependent.
 */
Then(
  "the backup history shows {int} backup(s)",
  async ({ site, backupHistory }, expected: number) => {
    await backupHistory.reload();
    await backupHistory.expectRowCount(expected);
    expect(
      await countBackups(site.transport),
      "archives BackWPup reports as stored",
    ).toBe(expected);
  },
);

/**
 * That nothing in the history failed or was aborted.
 *
 * Re-read from the server for the reason the count step gives — and here that is what stops the
 * assertion passing for free rather than merely making it reliable: a stale table straight after a
 * backup renders no rows at all, and "no row failed" is trivially true of no rows.
 *
 * Matched on the delete control the row template offers only on that branch, so an *aborted*
 * backup counts too — it renders no failure icon at all, and keying on the icon would let exactly
 * the rows this exists to catch pass through. See `BackupHistoryTable.failedRows`.
 */
Then("no backup in the history has failed", async ({ backupHistory }) => {
  await backupHistory.reload();
  await backupHistory.expectNoFailures();
});

/**
 * That the history lists the one run there was, as a run the user aborted — no download, no
 * restore, "Aborted by user" where a finished run shows its data.
 *
 * Re-read from the server first, for the reason the count step gives. Only a row the plugin's own
 * hook marks unsuccessful can match, so a completed run could not satisfy it whatever it displayed.
 */
Then(
  "the backup history shows the run as aborted by the user",
  async ({ backupHistory }) => {
    await backupHistory.reload();
    await backupHistory.expectRowCount(1);
    await expect(
      backupHistory.abortedRows,
      "history rows for runs a user aborted",
    ).toHaveCount(1);
  },
);

// ── Downloading ──────────────────────────────────────────────────────────────

/**
 * Downloads the newest archive, under the name the browser was offered.
 *
 * It lands in the test's own `outputDir`, so a download joins the run's other artefacts instead of
 * a shared directory in the repository, and is collected with them on failure. Saving it under the
 * **offered** name rather than a fixed one is what lets the next step check the two agree without
 * either step having to hand the other a path.
 */
When("I download the newest backup", async ({ backupHistory, $testInfo }) => {
  await backupHistory.waitForLoaded();
  const download = await backupHistory.download(backupHistory.newestRow);
  await download.saveAs($testInfo.outputPath(download.suggestedFilename()));
});

/**
 * The SHA-256 of a file on the runner, streamed rather than read whole.
 *
 * Streamed because the same assertion should stay usable against a files backup, which on a real
 * site runs to gigabytes — reading one into a buffer to hash it would exhaust the runner.
 */
async function sha256Of(file: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

/**
 * That the file on disk is the archive BackWPup holds — by name, by size, and byte for byte.
 *
 * Three assertions, each catching what the one before it cannot. The **name** proves the browser was
 * served the archive WP-CLI reports rather than some other one: the step above saved under the
 * offered name, so looking it up under the name from WP-CLI fails outright when they differ. The
 * **size** proves a whole file arrived, where "not empty" would pass for a truncated one or for an
 * error page saved with the right name — and when it is wrong it says so plainly, which a digest
 * cannot. The **digest** is the one that actually settles it: a body corrupted in place, or a
 * truncation that happens to land on the same length, matches on size and differs here.
 *
 * The site's half is computed on the site, so proving this costs one small reply rather than a
 * second transfer of the archive.
 */
Then(
  "the downloaded file is the newest stored archive",
  async ({ site, $testInfo }) => {
    const [newest] = await listBackups(site.transport);
    expect(newest, "the newest stored archive").toBeDefined();
    if (newest === undefined) throw new Error("unreachable: asserted above");

    const saved = $testInfo.outputPath(newest.name);
    expect(
      existsSync(saved),
      `the download should have been saved as "${newest.name}" — the name BackWPup reports for it`,
    ).toBe(true);
    expect(statSync(saved).size, "the downloaded archive's size").toBe(
      newest.sizeBytes,
    );

    const { path } = newest;
    expect(
      path,
      `the newest archive ("${newest.name}") should report where it lives on the site`,
    ).toBeDefined();
    if (path === undefined) throw new Error("unreachable: asserted above");
    expect(
      await sha256Of(saved),
      "the downloaded archive should be byte-for-byte what the site holds",
    ).toBe(await fileChecksum(site.transport, path));
  },
);

// ── Deleting ─────────────────────────────────────────────────────────────────

/**
 * Deletes the newest backup through the table's own per-row action, and checks that is what went.
 *
 * Arming and confirming are separate page-object calls because the action is irreversible; a step
 * that says "I delete it" means both, so both happen here.
 *
 * The before/after comparison is what makes "the newest" load-bearing: a count alone would pass
 * just as happily if the row action had removed the *oldest* archive, which is the failure a table
 * that mis-binds its per-row data would actually produce.
 */
When("I delete the newest backup", async ({ site, backupHistory }) => {
  await backupHistory.waitForLoaded();
  const before = await listBackups(site.transport);
  expect(before.length, "there should be a backup to delete").toBeGreaterThan(
    0,
  );

  await backupHistory.openDelete(backupHistory.newestRow);
  await backupHistory.confirmDelete();

  await expect
    .poll(async () => (await listBackups(site.transport)).map((b) => b.name), {
      message:
        "deleting the newest backup should remove that archive and no other",
    })
    .toEqual(before.slice(1).map((b) => b.name));
});

/** Ticks the header checkbox, which the plugin uses to select every row at once. */
When("I select every backup in the history", async ({ backupHistory }) => {
  await backupHistory.waitForLoaded();
  await backupHistory.setAllSelected(true);
});

/**
 * Applies the bulk delete and confirms it.
 *
 * Two page-object calls, because pressing Apply only arms the action: the plugin opens a
 * confirmation and issues nothing until that is accepted. A step that says "I delete them" means
 * the user went through with it, so both happen here.
 */
When("I delete the selected backups", async ({ backupHistory }) => {
  await backupHistory.applyBulkAction("delete");
  await backupHistory.confirmBulkDelete();
});
