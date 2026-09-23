import { setTimeout as sleep } from "node:timers/promises";

import { expect } from "@playwright/test";

import { BACKUP_TIMEOUT_MS } from "./backups";
import { backwpupCli, describeCli } from "./cli";
import { HISTORY_ROWS_PHP, historyRecords } from "./history";
import { PROBE_INTERVALS, forgiving } from "./polling";
import { evalPhp } from "../../../common/wp/php";
import { isObject } from "../../../common/guards";
import type { CliResult } from "./cli";
import type { HistoryRecord } from "./history";
import type { Transport } from "../../../common/config/types";

/**
 * A job's run while it is still in flight: whether one is running, which job it belongs to, and
 * whether every run the history records has finished recording its end.
 *
 * Two facts about the plugin shape everything here, both measured on the cells:
 *
 *  - **The running marker is not the process.** BackWPup keeps a marker file while a job works and
 *    removes it as the run ends — but `wp backwpup kill` removes it too, at once, while the request
 *    running the job carries on until it notices (about a second later), logs the abort and records
 *    how the run ended. "Nothing is running" and "the run has ended" are therefore different
 *    questions, and only the second is safe to act on.
 *  - **A run records its own end.** Its history row reads `created` from the moment the job is set
 *    up until its last steps mark it `completed`, `aborted` or `failed` — the signal the dashboard's
 *    own abort handler waits on, through the plugin's `job-abort-status` route.
 */

/** What a site's BackWPup is doing right now. */
export interface RunState {
  /** Whether BackWPup is loaded at all. When it is not, nothing is running and no history is read. */
  readonly loaded: boolean;
  /**
   * The run holding the plugin's running marker, if one does. Its job is absent while the marker
   * cannot be read — the plugin rewrites it every second, and a read can land mid-write.
   */
  readonly running?: { readonly jobId?: number };
  /** Every row of the backup history, oldest first. */
  readonly history: readonly HistoryRecord[];
}

/**
 * The PHP that reports the {@link RunState} as JSON, in one request.
 *
 * Guarded on the plugin's classes, so a site whose plugin is gone — a scenario may delete it —
 * answers "not loaded" instead of fataling. The job is read from the marker's own working data,
 * the same data `wp backwpup status` prints.
 */
export const RUN_STATE_PHP = `
if ( class_exists( 'BackWPup' ) && class_exists( 'BackWPup_Job' ) ) {
	$marker  = BackWPup::get_plugin_data( 'running_file' );
	$running = null;
	clearstatcache( true, $marker );
	if ( file_exists( $marker ) ) {
		$working = BackWPup_Job::get_working_data();
		$running = [ 'job_id' => is_object( $working ) && isset( $working->job['jobid'] ) ? (int) $working->job['jobid'] : null ];
	}
	${HISTORY_ROWS_PHP}
	echo wp_json_encode( [ 'loaded' => true, 'running' => $running, 'history' => $rows ] );
} else {
	echo wp_json_encode( [ 'loaded' => false ] );
}
`;

/** The `running` half of a reply: `null` is idle, a `null` job id is a marker read mid-write. */
function runningIn(value: unknown): Pick<RunState, "running"> {
  if (value === null) return {};
  const jobId = isObject(value) ? value.job_id : undefined;
  if (jobId === null) return { running: {} };
  if (typeof jobId === "number" && Number.isInteger(jobId)) {
    return { running: { jobId } };
  }
  throw new Error(
    `[backwpup/job-runs] expected the running job to be null or carry an integer job id, got ${JSON.stringify(value)}.`,
  );
}

/**
 * Parses what {@link RUN_STATE_PHP} printed.
 *
 * @param json - the snippet's output.
 * @throws {@link Error} if it is not a run state — a reply that cannot be read must never pass as a
 * site with nothing running.
 */
export function parseRunState(json: string): RunState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(
      `[backwpup/job-runs] the run state did not come back as JSON: ${json.slice(0, 500) || "(empty)"}`,
    );
  }
  if (!isObject(parsed) || typeof parsed.loaded !== "boolean") {
    throw new Error(
      `[backwpup/job-runs] expected a run state, got ${JSON.stringify(parsed)}.`,
    );
  }
  if (!parsed.loaded) return { loaded: false, history: [] };
  return {
    loaded: true,
    ...runningIn(parsed.running),
    history: historyRecords(parsed.history),
  };
}

/**
 * What the site's BackWPup is running, and what its history records, as of one request.
 *
 * @param transport - the site to ask.
 * @throws {@link Error} if the site could not be asked, or answered in a shape it does not have.
 */
export async function readRunState(transport: Transport): Promise<RunState> {
  return parseRunState(
    await evalPhp(
      transport,
      RUN_STATE_PHP,
      "reading what BackWPup is running",
      "backwpup/job-runs",
    ),
  );
}

/** The runs the history still records as in progress. */
export function unfinishedRuns(state: RunState): readonly HistoryRecord[] {
  return state.history.filter((row) => row.status === "created");
}

/**
 * Where one job's run stands, in words — `"ended"` once nothing is running and every run the history
 * holds for that job has recorded its end.
 *
 * A job with **no** run recorded has not ended: the site starts a dispatched job a moment after the
 * command that asked for it returns, and "nothing happened yet" must not read as "it is over". The
 * one thing this cannot tell apart is a second run of the same job that has not started yet from
 * the first one that has ended, so a caller expecting several runs of one job must count them.
 */
export function runProgress(state: RunState, jobId: number): string {
  if (!state.loaded) return "BackWPup is not loaded, so no run can be read";
  const runs = state.history.filter((row) => row.jobId === jobId);
  if (state.running !== undefined) {
    return `a run of job ${String(state.running.jobId ?? "(unreadable)")} is still running`;
  }
  if (runs.length === 0) {
    return `no run of job ${String(jobId)} is recorded yet`;
  }
  if (runs.some((row) => row.status === "created")) {
    return `a run of job ${String(jobId)} is still recording its end`;
  }
  return "ended";
}

/**
 * How long a job the suite just dispatched may take to be seen running.
 *
 * The site starts a job in a request of its own, after a random pause of up to 0.9 s the plugin
 * takes to keep two starts from colliding, so it is running about a second after dispatch. The
 * budget is room for a slow host, not a guess at the job's length.
 */
export const RUN_START_TIMEOUT_MS = 60_000;

/**
 * Waits until the site is running a given job.
 *
 * @param transport - the site to watch.
 * @param jobId - the job that should be running.
 * @param timeoutMs - how long to wait.
 * @throws {@link Error} if that job is not seen running within the budget.
 */
export async function waitForJobRunning(
  transport: Transport,
  jobId: number,
  timeoutMs = RUN_START_TIMEOUT_MS,
): Promise<void> {
  await expect
    .poll(
      forgiving(async () => (await readRunState(transport)).running?.jobId),
      {
        message:
          `job ${String(jobId)} should be running — it was just started, and BackWPup's running ` +
          "marker never named it. A run short enough can end before anything sees it; slow it " +
          'with BackWPup\'s "Reduce server load" setting.',
        timeout: timeoutMs,
        intervals: [250],
      },
    )
    .toBe(jobId);
}

/**
 * Waits until one job's run has ended and recorded how — see {@link runProgress} for what "ended"
 * means, and for the one case it cannot see.
 *
 * @param transport - the site to watch.
 * @param jobId - the job whose run to wait for.
 * @param timeoutMs - how long to wait; a real backup's budget by default.
 * @throws {@link Error} if the run has not ended within the budget, naming where it stood.
 */
export async function waitForRunToEnd(
  transport: Transport,
  jobId: number,
  timeoutMs = BACKUP_TIMEOUT_MS,
): Promise<void> {
  await expect
    .poll(
      forgiving(async () => runProgress(await readRunState(transport), jobId)),
      {
        message: `job ${String(jobId)}'s run should have ended and recorded how`,
        timeout: timeoutMs,
        intervals: [...PROBE_INTERVALS],
      },
    )
    .toBe("ended");
}

/** How long {@link stopRunningJobs} gives each part of its work, in milliseconds. */
export interface StopBudgets {
  /** For the running marker to go once the job is told to stop. */
  readonly stopMs: number;
  /** For the history to record the run's end once nothing is running. */
  readonly settleMs: number;
  /** Between two looks at the site. */
  readonly pollMs: number;
  /** Before telling a job that is still running to stop again. */
  readonly resendMs: number;
}

/**
 * The budgets the shared teardown runs with.
 *
 * Small, because the teardown hook has one fixed budget for all its duties: an abort takes effect
 * within about a second and the run records its end moments later (measured on both nginx cells),
 * so thirty seconds each is room for a slow host while leaving the removal and sweeps theirs.
 */
export const STOP_BUDGETS: StopBudgets = {
  stopMs: 30_000,
  settleMs: 30_000,
  pollMs: 1_000,
  resendMs: 5_000,
};

/** What the site was still doing, in words; `undefined` when it was idle. */
function workInFlight(state: RunState): string | undefined {
  if (state.running !== undefined) {
    const job = state.running.jobId;
    return `a backup of ${job === undefined ? "a job whose marker could not be read" : `job ${String(job)}`} was still running when the scenario ended`;
  }
  const unfinished = unfinishedRuns(state);
  if (unfinished.length === 0) return undefined;
  const jobs = [...new Set(unfinished.map((row) => row.jobId ?? 0))];
  return `a run of job ${jobs.join(", ")} was still recording its end when the scenario ended`;
}

/**
 * Stops any backup job still running on a site, and waits for its run to record how it ended —
 * BackWPup's `ProductConfig.stopRunningWork`, which the shared teardown calls before it removes the
 * plugin.
 *
 * A job runs in a web request, so it outlives the scenario that started it; uninstalling the plugin
 * underneath it lets that request re-create the options and table the uninstall has just removed,
 * or go on writing an archive into a directory the teardown is clearing. So a running job is told
 * to stop with the plugin's own `wp backwpup kill`, and told again if its marker comes back: the
 * plugin checks for the marker and rewrites it as two separate steps, so by its source an abort
 * landing between them is undone. Then the run is given time to record its end, which is when its
 * request is done.
 *
 * On an idle site this is a single request. It never throws for having found work, only for work
 * that would not stop.
 *
 * @param transport - the site to settle.
 * @param budgets - how long each part may take; the teardown's own by default.
 * @returns what it found and did, or `undefined` when there was nothing to stop.
 * @throws {@link Error} if a job was still running once the stop budget was spent, or if the site
 * could not be asked.
 */
export async function stopRunningJobs(
  transport: Transport,
  budgets: StopBudgets = STOP_BUDGETS,
): Promise<string | undefined> {
  let state = await readRunState(transport);
  const found = workInFlight(state);
  if (found === undefined) return undefined;

  const stopBy = Date.now() + budgets.stopMs;
  let lastKill: CliResult | undefined;
  let lastKillAt = Number.NEGATIVE_INFINITY;
  while (state.running !== undefined) {
    if (Date.now() >= stopBy) {
      throw new Error(
        `[backwpup/job-runs] ${found}, and it was still running ${String(budgets.stopMs / 1000)} s ` +
          "after being told to stop — removing the plugin now would race it. The last stop " +
          `request: ${lastKill === undefined ? "(none)" : describeCli(lastKill)}`,
      );
    }
    if (Date.now() - lastKillAt >= budgets.resendMs) {
      lastKill = await backwpupCli(transport, ["kill"]);
      lastKillAt = Date.now();
    }
    await sleep(budgets.pollMs);
    state = await readRunState(transport);
  }

  const settleBy = Date.now() + budgets.settleMs;
  while (unfinishedRuns(state).length > 0 && Date.now() < settleBy) {
    await sleep(budgets.pollMs);
    state = await readRunState(transport);
  }
  if (unfinishedRuns(state).length > 0) {
    return `${found}; its run is still recorded as in progress, with nothing left running to finish it.`;
  }
  return lastKill === undefined
    ? `${found}; it was left to finish before the plugin was removed.`
    : `${found}; it was stopped before the plugin was removed.`;
}
