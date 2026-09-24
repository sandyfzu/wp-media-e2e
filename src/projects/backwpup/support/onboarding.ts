import { expect } from "@playwright/test";
import type { TestInfo } from "@playwright/test";

import { evalPhp } from "../../../common/wp/php";
import { nextScheduled } from "../../../common/wp/cron";
import { getOption } from "../../../common/wp/options";
import { readRouting } from "../../../common/config/metadata";
import {
  HOOK_TIMEOUT_MS,
  declaredResidue,
  replacePluginUnderTest,
} from "../../../common/hooks/plugin-lifecycle";
import {
  JOB_CONTENTS,
  describeJobContents,
  readStoredJobs,
  scheduledJobs,
} from "./job-options";
import { LOCAL_STORAGE } from "../pages/storages";
import type { JobContents, StoredJob } from "./job-options";
import type { ResolvedArtifact } from "../../../common/artifacts/types";
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
 * How many installs {@link finishActivation} lets a site have — the `@plugin` hook's, then up to two
 * more — before it stops putting a lost activation race down to chance.
 */
export const ACTIVATION_ATTEMPTS = 3;

/** What BackWPup's activation routine left behind: the onboarding flag, and the jobs it stored. */
export interface ActivationOutcome {
  /** The raw {@link ONBOARDING_OPTION}, `undefined` when the row does not exist. */
  readonly flag: string | undefined;
  /** Every stored job, placeholders included. */
  readonly jobs: readonly StoredJob[];
}

/**
 * Whether an activation left the site the way a fresh install is: owing its onboarding, and holding
 * one job — the placeholder the plugin runs the first backup from. Measured on both editions, two
 * clean installs each.
 */
export function isPristineActivation(outcome: ActivationOutcome): boolean {
  const [job, ...others] = outcome.jobs;
  return (
    isOnboardingPending(outcome.flag) &&
    job?.tempJob === true &&
    others.length === 0
  );
}

/** An {@link ActivationOutcome} in words, for a warning or a failure. */
function describeActivation(outcome: ActivationOutcome): string {
  const placeholders = outcome.jobs.filter((job) => job.tempJob).length;
  return (
    `${ONBOARDING_OPTION} = ${JSON.stringify(outcome.flag)} and ${String(outcome.jobs.length)} ` +
    `job(s), ${String(placeholders)} of them a placeholder`
  );
}

/**
 * Runs the plugin's activation routine and makes sure the site came out of it as a fresh install
 * does, reinstalling the plugin when it did not.
 *
 * **Installing does not run BackWPup's own bootstrap.** The plugin defers `BackWPup_Install::
 * activate()` to `init`, which WP-CLI's `plugin activate` never fires: straight after `wp plugin
 * install --activate`, `backwpup_version`, `backwpup_onboarding` and `backwpup_jobs` are all absent
 * (measured). The routine runs in whichever request next loads the plugin — in this suite normally
 * the `@plugin` hook's own active-state check, so the bootstrap here is usually a no-op, kept so this
 * never depends on which commands that hook happens to run.
 *
 * **That is a race, and losing it corrupts the install.** Provoked on a live cell by booting
 * WordPress twice straight after activation, it goes wrong two ways. A second request 150–450 ms
 * behind the first reads the jobs after the first created its placeholder, and so takes the upgrade
 * path, whose first statement deletes the onboarding flag (`BackWPup_Migrate::convert_jobs()`) — 4
 * times in 4 at 300 ms. Two requests together instead both create a placeholder, and because every
 * job write rewrites the whole jobs option from the request's own copy (`BackWPup_Option::update()`),
 * the later one drops the earlier's placeholder flag — leaving a real, scheduled job on a site nobody
 * configured: two jobs 7 times in 18, and in each whose flags were read, the first no longer a
 * placeholder. A cell whose cron fires every minute supplies that request by chance, a few installs
 * in a hundred, and nothing on this side can hold it off — so either outcome is redone from a clean
 * install, and reported.
 *
 * @param transport - the freshly installed site.
 * @param reinstall - puts a fresh copy of the plugin under test on the site, the way the `@plugin`
 * hook did — see {@link reinstallPlugin}.
 * @throws {@link Error} if WordPress could not be run, if a reinstall failed, or if
 * {@link ACTIVATION_ATTEMPTS} installs in a row left the site other than a fresh install is.
 */
export async function finishActivation(
  transport: Transport,
  reinstall: () => Promise<void>,
): Promise<void> {
  let outcome = await runActivation(transport);
  for (
    let attempt = 2;
    attempt <= ACTIVATION_ATTEMPTS && !isPristineActivation(outcome);
    attempt++
  ) {
    console.warn(
      `[backwpup/onboarding] BackWPup's activation left ${describeActivation(outcome)} — what ` +
        "another request reaching the site while it ran leaves, or a leftover the sweep does not " +
        "know about — reinstalling " +
        `(install ${String(attempt)} of ${String(ACTIVATION_ATTEMPTS)}).`,
    );
    await reinstall();
    outcome = await runActivation(transport);
  }
  expect(
    isPristineActivation(outcome),
    "a freshly installed BackWPup should owe its onboarding and hold only its first-backup " +
      `placeholder (${describeActivation(outcome)}) after ${String(ACTIVATION_ATTEMPTS)} installs — ` +
      "another request reaching the site during every one, or a footprint of an earlier run that " +
      "the sweep does not know about, looks exactly like this",
  ).toBe(true);
}

/**
 * Boots WordPress so the plugin's pending activation routine runs, then reads what it left.
 *
 * The snippet is a no-op on purpose: `wp eval` loads core and the active plugins and fires `init`
 * before it evaluates anything, which is what runs the routine.
 */
async function runActivation(transport: Transport): Promise<ActivationOutcome> {
  await evalPhp(
    transport,
    "// bootstrap only",
    "running the plugin's activation routine",
    "backwpup/onboarding",
  );
  return {
    flag: await readOnboardingFlag(transport),
    jobs: await readStoredJobs(transport),
  };
}

/**
 * The reinstall {@link finishActivation} performs: the `@plugin` hook's install — the plugin removed
 * with the leftovers the product declares swept, then the artifact installed and activated afresh —
 * all but its clearing of `debug.log`. The teardown still judges the scenario's whole log, including
 * whatever the install being replaced left in it.
 *
 * The hook's install ran on a budget of its own; this one runs inside a step, on the scenario's, so
 * it adds the hook's budget first. A scenario with no timeout (`0`) is left alone.
 *
 * @param transport - the scenario's site.
 * @param artifact - the plugin under test, as the `pluginArtifact` fixture resolves it.
 * @param testInfo - the scenario's own test info; its project names the product.
 */
export function reinstallPlugin(
  transport: Transport,
  artifact: ResolvedArtifact,
  testInfo: Pick<TestInfo, "timeout" | "setTimeout"> & {
    readonly project: Pick<TestInfo["project"], "metadata">;
  },
): () => Promise<void> {
  return async () => {
    if (testInfo.timeout !== 0) {
      testInfo.setTimeout(testInfo.timeout + HOOK_TIMEOUT_MS);
    }
    const { product } = readRouting(testInfo.project.metadata);
    await replacePluginUnderTest(transport, artifact, declaredResidue(product));
  };
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
 * @param reinstall - how to put a fresh copy of the plugin on the site if its activation raced —
 * see {@link finishActivation}.
 * @returns the id of the scheduled job onboarding created.
 * @throws {@link Error} if PHP failed, or if the site did not end up in the expected state.
 */
export async function completeOnboarding(
  transport: Transport,
  contents: JobContents,
  reinstall: () => Promise<void>,
): Promise<number> {
  // Seeding a site whose activation raced would complete an onboarding it no longer owes, so the
  // fresh state is settled first — and fails here, clearly, when it cannot be had.
  await finishActivation(transport, reinstall);

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
