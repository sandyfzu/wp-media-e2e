import { expect } from "@playwright/test";

import { evalPhp } from "../../../common/wp/php";
import { nextScheduled } from "../../../common/wp/cron";
import { getOption } from "../../../common/wp/options";
import {
  JOB_CONTENTS,
  describeJobContents,
  readStoredJobs,
  scheduledJobs,
} from "./job-options";
import { LOCAL_STORAGE } from "../pages/storages";
import type { JobContents } from "./job-options";
import type { Transport } from "../../../common/config/types";

/**
 * BackWPup's onboarding state: reading whether a site still owes it, and putting a site past it.
 *
 * The plugin gates the whole admin on one site option. While it is set, *every* `page=backwpup*`
 * request except the about, onboarding, first-backup and support screens is redirected to the
 * onboarding page, and completing onboarding deletes it. So this option — not a URL, not a heading —
 * is what
 * "has this site been onboarded?" actually means.
 *
 * **It is written lazily, and that matters.** A fresh install does not set it during the install
 * command: the plugin schedules its own upgrade routine on `init`, so the flag appears on the first
 * WordPress request that loads the activated plugin. The same request then redirects (`admin_init`
 * runs after `init`), which is why a scenario should observe the redirect first and read this
 * afterwards — reading it straight after a WP-CLI install would be a race against the product's own
 * bootstrap.
 *
 * The read and the judgement are separate so a caller can report the raw value it saw: "expected
 * true, received false" is a poor way to describe a missing option row.
 */

/**
 * The site option that keeps a site inside onboarding.
 *
 * A *site* option, which on single-site WordPress is an ordinary option row; every site this suite
 * drives is single-site.
 */
export const ONBOARDING_OPTION = "backwpup_onboarding";

/**
 * The raw value of {@link ONBOARDING_OPTION}, or `undefined` when the row does not exist.
 *
 * @param transport - the site to ask.
 * @throws {@link Error} if the option cannot be read at all — a site that cannot answer is not the
 * same as a site that has been onboarded.
 */
export function readOnboardingFlag(
  transport: Transport,
): Promise<string | undefined> {
  return getOption(transport, ONBOARDING_OPTION);
}

/**
 * Whether a raw {@link ONBOARDING_OPTION} value means "onboarding is still owed".
 *
 * The plugin writes a boolean `true`, which WordPress stores — and WP-CLI prints — as `1`, and
 * deletes the row rather than falsifying it when onboarding completes. Any falsy value is treated
 * as "not pending", the way WordPress itself would read it.
 */
export function isOnboardingPending(value: string | undefined): boolean {
  if (value === undefined) return false;
  const trimmed = value.trim();
  return trimmed !== "" && trimmed !== "0";
}

/**
 * Runs the plugin's activation routine, once, before anything else can.
 *
 * **Installing does not activate BackWPup's own bootstrap.** The plugin defers `BackWPup_Install::
 * activate()` to `init`, and WP-CLI's `plugin activate` never fires `init` — measured on a live
 * cell: straight after `wp plugin install --activate`, `backwpup_version`, `backwpup_onboarding` and
 * `backwpup_jobs` are all still absent, and one ordinary WP-CLI call afterwards sets them (3 of 3
 * attempts). So the routine actually runs in whichever *request* reaches `init` first.
 *
 * That is a race, and losing it corrupts the install. While `backwpup_version` is unset the plugin
 * considers itself due a migration; if a second request reaches `init` before the first has written
 * that version, it re-runs the routine, now sees the job the first one just created, and takes the
 * upgrade path — which **deletes the onboarding flag** (`BackWPup_Migrate::convert_jobs()`, its first
 * statement) on a site that has never been onboarded. A cell that pokes `wp-cron.php` every minute
 * supplies that second request for free, and it was observed failing roughly one run in two.
 *
 * Doing it here, in a single WP-CLI request, closes the window for good: once the version is
 * written the migration path can never be taken again for this install. Any `wp` call loads plugins
 * and so fires `init`; `eval` is used because it says out loud that running WordPress *is* the point.
 *
 * @param transport - the freshly installed site.
 * @throws {@link Error} if WordPress could not be run, or if the site did not come out of it owing
 * its onboarding — which is what a leaked footprint from an earlier run looks like, reported here
 * rather than as a puzzling redirect failure several steps later.
 */
export async function finishActivation(transport: Transport): Promise<void> {
  // The snippet is a no-op on purpose: booting WordPress *is* the call. `wp eval` loads core and
  // the active plugins and fires `init` before it evaluates anything, which is what runs the
  // routine; there is nothing for the PHP itself to do once that has happened.
  await evalPhp(
    transport,
    "// bootstrap only",
    "running the plugin's activation routine",
    "backwpup/onboarding",
  );
  const flag = await readOnboardingFlag(transport);
  expect(
    isOnboardingPending(flag),
    `a freshly installed BackWPup should owe its onboarding (${ONBOARDING_OPTION} = ${JSON.stringify(flag)}); ` +
      "an earlier scenario's footprint surviving its uninstall looks exactly like this",
  ).toBe(true);
}

// ── Putting a site past onboarding ───────────────────────────────────────────

/**
 * The WP-Cron hook BackWPup schedules every active job on, one event per job.
 *
 * The event's argument array is `{ arg: <job id> }`, which is what distinguishes one job's
 * schedule from another's — several events share this hook, so the hook name alone never
 * identifies a job (`inc/class-cron.php`).
 */
export const CRON_HOOK = "backwpup_cron";

/**
 * The PHP that completes onboarding, expressed as the calls the product itself makes.
 *
 * Recorded from a real onboarding on a live cell. The browser sends **three** mutating requests:
 * `cloudsaveandtest`, which saves the chosen destination's settings onto the placeholder job;
 * `updatejob` with an empty `storage_destinations[]`, whose only effect is to set that job's
 * destinations to `[]` — overwritten moments later by the submit, so it is deliberately not
 * reproduced; and the form POST that `BackWPup_Page_Onboarding::save_post_form()` handles.
 * Everything else onboarding shows is client-side until then. So this makes the two calls that
 * leave a mark, with the payloads the forms carry, instead of reproducing what they write.
 *
 * That distinction is the whole point: the plugin owns the job schema, the id allocation, the cron
 * registration and the placeholder-job cleanup, and a seeder that wrote those itself would be a
 * second implementation to keep in step. The only thing reproduced here is the onboarding page's
 * own rule for which job ids the two frequency fields address, because that is assigned while
 * *rendering* the page and this seeder never renders it.
 *
 * Exported for its unit test, which asserts the emitted snippet for every {@link JobContents};
 * callers use {@link completeOnboarding}.
 *
 * @param contents - what the resulting job should back up.
 */
export function completeOnboardingPhp(contents: JobContents): string {
  const slugs: readonly string[] = JOB_CONTENTS[contents];
  const wantsFiles = slugs.includes("FILE");
  const wantsDatabase = slugs.includes("DBDUMP");
  return `
$first = (int) get_site_option( \\WPMedia\\BackWPup\\Plugin\\Plugin::FIRST_JOB_ID, 0 );
if ( ! $first ) {
	WP_CLI::error( 'the plugin has not created its first-backup job yet' );
}

// The ids the onboarding page assigns while rendering, and save_post_form() reads back: the two
// after the first-backup job (inc/class-page-onboarding.php). On the fresh install this seeder
// requires, that job is the only one, so both are free; the verification afterwards is what
// catches it if they were not.
$files = $first + 1;
$database = $first + 2;
update_site_option( \\WPMedia\\BackWPup\\Plugin\\Plugin::FILES_JOB_ID, $files );
update_site_option( \\WPMedia\\BackWPup\\Plugin\\Plugin::DATABASE_JOB_ID, $database );

// Step 3 — the destination, saved exactly as cloudsaveandtest saves it during onboarding: onto the
// first-backup job, from which the form submit then clones every job it creates. The slug below is
// interpolated rather than encoded because it is a compile-time constant of this suite's own
// storage registry, not a value any caller supplies.
$folder = BackWPup::get_destination( '${LOCAL_STORAGE}' );
$defaults = $folder->option_defaults();
$job = BackWPup_Option::get_job( $first );
$_POST = [
	'backupdir'  => $job['backupdir'] ?? $defaults['backupdir'],
	'maxbackups' => $job['maxbackups'] ?? $defaults['maxbackups'],
];
$folder->edit_form_post_save( [ $first ] );

// The form submit. A data type is active exactly when its frequency field is present, and the
// value is the one the page renders by default, so this is a user who accepted every default.
$_POST = [ 'onboarding_storage' => [ '${LOCAL_STORAGE}' ] ];
${wantsFiles ? "$_POST[ 'job_' . $files . '_frequency' ] = 'monthly';" : ""}
${wantsDatabase ? "$_POST[ 'job_' . $database . '_frequency' ] = 'monthly';" : ""}

// save_post_form() ends in a redirect. WP-CLI answers one with a warning and a full backtrace on
// stderr, which is noise here; silencing it changes nothing, because every write happens first.
remove_filter( 'wp_redirect', 'WP_CLI\\\\Utils\\\\wp_redirect_handler' );
add_filter( 'wp_redirect', '__return_false' );
BackWPup_Page_Onboarding::save_post_form();
`;
}

/**
 * Completes onboarding on a freshly installed site, without driving it in the browser.
 *
 * Onboarding has a feature file of its own, and repeating it is not free: it costs three screens
 * **and a full backup of the site**, which the plugin starts the moment onboarding is saved and
 * which a scenario must then wait out. Scenarios that are *about* an already-configured site say so
 * with this instead.
 *
 * Verified against a real onboarding on a live cell, **for each {@link JobContents}** so no variant
 * rests on another's evidence: both routes run from the same fresh install, then compared field by
 * field. `wp backwpup job` came out byte-identical every time, down to the job id; of the ~133 keys
 * a job record holds, the only differences were `backupdir` and `dbdumpdbpassword`, which embed the
 * random hash that makes every install unique — plus, on the real side, the fields a completed run
 * writes, since submitting onboarding starts one.
 *
 * Two things it deliberately does **not** reproduce, neither of which onboarding decides:
 *  - four options the admin UI writes on any visit — the rating-notice state, the licence state and
 *    the message queue — which a scenario re-creates the moment it opens a screen;
 *  - a WP-Cron event for the hidden placeholder job. The plugin schedules that one
 *    non-deterministically on *both* routes (it re-schedules every active job on activation), so its
 *    presence is timing, not a property of either path. It is dated a month out either way, so the
 *    trigger in `common/wp/cron.ts` never sweeps it up.
 *
 * The outcome is **verified, never assumed**: the seeding call reports success by exiting zero,
 * which says only that PHP ran. What matters is what the site now holds, so that is read back.
 *
 * @param transport - the site to set up. It must have BackWPup freshly installed and activated,
 * and still owe its onboarding — the `@plugin` lifecycle leaves exactly that.
 * @param contents - what the resulting scheduled job should back up.
 * @returns the id of the scheduled job onboarding created.
 * @throws {@link Error} if PHP failed, or if the site did not end up in the expected state.
 */
export async function completeOnboarding(
  transport: Transport,
  contents: JobContents,
): Promise<number> {
  // The seeding call would fire `init` itself, and so would run the activation routine as a side
  // effect — but only if nothing else got there first. Doing it explicitly makes that ordering the
  // contract rather than a coincidence, and fails clearly when the site is not actually fresh.
  await finishActivation(transport);

  await evalPhp(
    transport,
    completeOnboardingPhp(contents),
    "completing onboarding",
    "backwpup/onboarding",
  );

  expect(
    isOnboardingPending(await readOnboardingFlag(transport)),
    "onboarding should no longer be owed after completing it",
  ).toBe(false);

  const jobs = scheduledJobs(await readStoredJobs(transport));
  expect(
    jobs.map((job) => describeJobContents(job.type)),
    "completing onboarding should leave exactly one scheduled backup job",
  ).toEqual([contents]);
  const [job] = jobs;
  if (job === undefined) throw new Error("unreachable: asserted above");

  expect(job.destinations, "the job's destinations").toEqual([LOCAL_STORAGE]);
  expect(job.activeType, "what drives the job's schedule").toBe("wpcron");
  expect(
    await nextScheduled(transport, CRON_HOOK, { arg: job.jobId }),
    "the job should have a WP-Cron event of its own",
  ).toBeDefined();

  return job.jobId;
}
