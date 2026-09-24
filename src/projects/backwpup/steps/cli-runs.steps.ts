import { expect } from "@playwright/test";

import { Given, Then, When } from "../fixtures";
import {
  BACKUP_TIMEOUT_MS,
  allowForBackup,
  outcomeOf,
  readLastRunLog,
  startJobInBackground,
} from "../support/backups";
import { describeCli } from "../support/cli";
import { readHistory } from "../support/history";
import {
  readRunState,
  runProgress,
  waitForJobRunning,
  waitForRunToEnd,
} from "../support/job-runs";
import { theScheduledJob } from "../support/job-options";
import { commandArgv } from "../support/placeholders";
import type { RunOutcome } from "../support/backups";
import type { Transport } from "../../../common/config/types";

/**
 * Steps for starting a job's run over WP-CLI, following it and stopping it.
 *
 * **A run is judged by what it left behind, never by what started it.** A foreground `run` never
 * reaches the verdict it would print — the job ends the WP-CLI process itself, at exit 0, whatever
 * it logged — and `--background` only reports that it asked. So these steps read the plugin's own
 * record of the run instead: its history row (how it ended, and what started it) and the log it
 * wrote, each from a source the command under test has no hand in.
 *
 * Every step that waits on a run makes room for a backup's length in the scenario's budget, so a
 * slow site fails with the wait's own message rather than with a bare scenario timeout.
 */

// ── Starting state ───────────────────────────────────────────────────────────

/**
 * The site's scheduled job, started in the background and seen running.
 *
 * An arrangement, so it goes through the instrumenting runner, which throws if the plugin refuses:
 * the scenarios that start here are about what another command does *to* a running job.
 */
Given("the scheduled job is running in the background", async ({ site }) => {
  const job = await theScheduledJob(site.transport);
  await startJobInBackground(site.transport, job.jobId);
  await waitForJobRunning(site.transport, job.jobId);
});

// ── Following a run ──────────────────────────────────────────────────────────

/**
 * Runs a command that blocks on the running job — `status` follows it to its end — under a budget
 * of its own, a backup's length, so a job that never ends fails here and says so. Its text follows
 * the same rules, placeholders included, as any other command's.
 */
When(
  "I watch the running backup with the BackWPup command {string}",
  async ({ cli, site, downloads, archives, $testInfo }, command: string) => {
    allowForBackup($testInfo);
    await cli.run(
      await commandArgv(command, {
        transport: site.transport,
        downloads,
        archives,
      }),
      BACKUP_TIMEOUT_MS,
    );
  },
);

/** Waits for the scheduled job's run to end and record how, however it ends. */
When("the scheduled job's run has ended", async ({ site, $testInfo }) => {
  allowForBackup($testInfo);
  const job = await theScheduledJob(site.transport);
  await waitForRunToEnd(site.transport, job.jobId);
});

/**
 * That the command followed the scheduled job's run, and did not answer before that run was over.
 *
 * `status` names the job and the log of the run it follows before it waits, which is what tells it
 * apart from the idle answer. Where the run stands is read first and at once: a command that
 * returned early would find the run still going, since the job these scenarios watch lasts seconds
 * longer than one question to the site takes.
 */
Then(
  "it watched the scheduled job's run through to its end",
  async ({ cli, site }) => {
    const state = await readRunState(site.transport);
    const job = await theScheduledJob(site.transport);
    const log = await readLastRunLog(site.transport);
    expect(
      runProgress(state, job.jobId),
      "where the run stood the moment the command answered",
    ).toBe("ended");
    expect(cli.last.stdout, describeCli(cli.last)).toContain(
      `Job ID: ${String(job.jobId)}`,
    );
    expect(cli.last.stdout, describeCli(cli.last)).toContain(log.name);
  },
);

// ── What a run left behind ───────────────────────────────────────────────────

/**
 * That a foreground run streamed the log of the run it made, as it made it.
 *
 * The command prints the job's log line by line, and names the log file near the top; that file
 * being the newest log, and the scheduled job's, ties what was printed to the run the site recorded.
 */
Then("it streamed the log of the run it made", async ({ cli, site }) => {
  const job = await theScheduledJob(site.transport);
  const log = await readLastRunLog(site.transport);
  expect(
    log.jobId,
    `the newest log, ${log.name}, should be the scheduled job's`,
  ).toBe(job.jobId);
  expect(cli.last.stdout, describeCli(cli.last)).toContain(
    `Logfile is: ${log.name}`,
  );
});

/**
 * The whole backup history, asserted to be exactly this: every row the scheduled job's, ending as
 * `status`, started by `trigger` — the plugin's own word for what started a run, such as `wp-cli`
 * for a run inside WP-CLI and `backup_now_job` for one handed to the web server.
 *
 * The whole history rather than a filtered slice, so a run nobody expected — a refused command that
 * started one after all — fails here instead of being left out of the count.
 */
Then(
  "the backup history holds {int} {word} run(s) of the scheduled job, started by {string}",
  async ({ site }, count: number, status: string, trigger: string) => {
    const job = await theScheduledJob(site.transport);
    const history = await readHistory(site.transport);
    expect(
      history.map((row) => ({
        jobId: row.jobId,
        status: row.status,
        trigger: row.trigger,
      })),
      `the backup history: ${JSON.stringify(history)}`,
    ).toEqual(
      Array.from({ length: count }, () => ({
        jobId: job.jobId,
        status,
        trigger,
      })),
    );
  },
);

/** That no run was recorded at all — no command started one, whatever it said. */
Then("the backup history holds no runs", async ({ site }) => {
  expect(
    await readHistory(site.transport),
    "runs the backup history records",
  ).toEqual([]);
});

/**
 * That the newest log is the scheduled job's and ended as `expected`.
 *
 * The job id matters as much as the counts: the command reads a header it cannot parse as job `0`
 * with no errors and no warnings, so the right id is what proves the counts were read at all.
 */
async function expectNewestLog(
  transport: Transport,
  expected: RunOutcome,
): Promise<void> {
  const job = await theScheduledJob(transport);
  const log = await readLastRunLog(transport);
  expect(
    { jobId: log.jobId, outcome: outcomeOf(log) },
    `the newest log, ${log.name}: ${String(log.errors)} error(s), ${String(log.warnings)} warning(s)`,
  ).toEqual({ jobId: job.jobId, outcome: expected });
}

Then(
  "the scheduled job's newest log reports no errors and no warnings",
  async ({ site }) => {
    await expectNewestLog(site.transport, "finished");
  },
);

/** What an abort leaves: BackWPup logs the abort, and the run's end, as warnings. */
Then(
  "the scheduled job's newest log reports warnings but no errors",
  async ({ site }) => {
    await expectNewestLog(site.transport, "warnings");
  },
);
