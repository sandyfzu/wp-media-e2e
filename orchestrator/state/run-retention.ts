import { lstat, readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import {
  DEFAULT_RETENTION,
  MAX_REPORTS_KEEP,
  applyRetention,
  describeReason,
  formatBytes,
  isoInstant,
  listGroupRuns,
  planRetention,
  removeLeftovers,
  type DeleteReason,
  type Removal,
  type RemovalFailure,
  type RetentionDecision,
  type RetentionEntry,
  type RetentionPolicy,
  type SkippedEntry,
} from "../../src/common/reporting/retention";
import { TASK_ID_PATTERN } from "../config/schema";
import { readCapped, type CappedRead } from "../runs/end";
import { RUN_FILES, RUNS_DIR, runIdOf } from "../runs/identity";
import { errorCode } from "../runs/process-group";
import { readRecordSummary } from "../runs/record";

/**
 * Run-folder retention: a task's `runs/<task>-<n>/` folders pruned by the suite's own report policy
 * (`planRetention`, `applyRetention`), one task a group — the cap is `runs.reportsKeep`, as for its
 * reports. Each folder is dated by its record's `startedAt`, never a modification time, and only a
 * record that names that very folder and task dates it; any other folder is undated, which the policy
 * always keeps. Never throws: everything that went wrong is in the report, for the caller to log.
 *
 * - **complete** — the record says `ended`: the run's log and outcome were written to the end, so the
 *   newest such folder is the one a person reads, and the policy keeps it longest.
 * - **empty** — never: a run folder holds a run the orchestrator started, and even one that tested
 *   nothing (`bddgen` failing, no scenario matching) has a log that says why. An empty entry would go
 *   whatever its age.
 * - **protected** — the run in progress, and every folder whose record still says `running`: that is
 *   a run in progress or one an orchestrator lost (killed or crashed under it), whose processes may
 *   still write its log and read its stop file — the drain needs that folder to exist. The orphan
 *   check rewrites a dead one as ended, after which it is pruned like any other.
 */

/** The largest `run.json` read, in bytes: a record, its `run.finished` included, is a few KiB. */
export const MAX_RECORD_BYTES = 1024 * 1024;

/** One of a task's run folders, as the planner sees it. */
export interface RunFolder extends RetentionEntry {
  /** The folder's name, the run's id: `bpng-12`. */
  readonly name: string;
  /** The run's number in its task. */
  readonly number: number;
  /** What its record says, or `unread` when none dates it ({@link RunFolder.undated}). */
  readonly record: "running" | "ended" | "unread";
  /** Why its record does not date it; absent when it does. */
  readonly undated?: string;
}

/** What one pruning is about. */
export interface RunRetentionInput {
  /** The state directory, absolute; its `runs/` folder holds every task's run folders. */
  readonly stateDir: string;
  /** The task whose run folders are pruned. */
  readonly taskId: string;
  /** The config's `runs.reportsKeep`: the cap, `0` for none; the suite's default when absent. */
  readonly keep?: number;
  /** The run in progress' folder, absolute: never removed. */
  readonly current?: string;
  /** The time to measure ages against, epoch ms. */
  readonly now: number;
}

/** What one pruning did. */
export interface RunRetentionReport {
  /** The policy it applied. */
  readonly policy: RetentionPolicy;
  /** Every folder's fate, newest first. */
  readonly plan: readonly RetentionDecision<RunFolder>[];
  readonly removed: readonly Removal<RunFolder>[];
  /** Folders already gone when their turn came: another pruning removed them first. */
  readonly gone: readonly string[];
  /** What interrupted removals had left, removed now. */
  readonly leftovers: readonly {
    readonly path: string;
    readonly bytes: number;
  }[];
  /** Entries named like the task's runs that are no run folder (a link, a file), left alone. */
  readonly skipped: readonly SkippedEntry[];
  /** What it could not remove — or could not even list. */
  readonly failed: readonly RemovalFailure[];
}

/**
 * The suite's policy with the config's cap — mapped exactly as the suite maps `E2E_REPORTS_KEEP`:
 * absent is the default, `0` lifts only the cap (the age rules still run).
 *
 * @param keep - `runs.reportsKeep`.
 * @returns the policy.
 * @throws {@link RangeError} for a cap that is not a whole number from 0 to `MAX_REPORTS_KEEP`.
 */
export function runRetentionPolicy(keep?: number): RetentionPolicy {
  if (keep === undefined) return DEFAULT_RETENTION;
  if (!Number.isSafeInteger(keep) || keep < 0 || keep > MAX_REPORTS_KEEP)
    throw new RangeError(
      `The run-folder cap must be a whole number from 0 to ${String(MAX_REPORTS_KEEP)}, got ${String(keep)}.`,
    );
  return { ...DEFAULT_RETENTION, keep };
}

/**
 * A folder name's run number when it is exactly one of the task's run ids — the name `runIdOf` gives
 * that number — so `bpng-012`, `bpng-0`, `bpngx-1` or another task's id is not.
 *
 * @param name - a folder's name in `runs/`.
 * @param taskId - the task, a valid task id.
 * @returns the number, or `undefined` when the name is not the task's.
 */
export function runNumberOf(name: string, taskId: string): number | undefined {
  const prefix = `${taskId}-`;
  if (!name.startsWith(prefix)) return undefined;
  const number = Number(name.slice(prefix.length));
  // Only a number `runIdOf` accepts, written back exactly as it writes it: no `012`, `1e3`, ` 1`.
  if (!Number.isSafeInteger(number) || number < 1) return undefined;
  return runIdOf(taskId, number) === name ? number : undefined;
}

/**
 * What a run folder's record says of it: when the run started and how far it got. Undated — kept by
 * the policy — when the record is missing, unreadable, too large, not a record, another folder's or
 * task's, or dated in any form but the one the orchestrator writes.
 *
 * @param read - the folder's `run.json`, read within a cap.
 * @param name - the folder's name.
 * @param taskId - the task being pruned.
 * @returns its start (`NaN` when undated), whether it ended, and why it is undated.
 */
export function recordDating(
  read: CappedRead,
  name: string,
  taskId: string,
): Pick<RunFolder, "time" | "complete" | "record" | "undated"> {
  const undated = (
    why: string,
  ): Pick<RunFolder, "time" | "complete" | "record" | "undated"> => ({
    time: Number.NaN,
    complete: false,
    record: "unread",
    undated: why,
  });
  if (read.kind === "missing") return undated("no run.json");
  if (read.kind === "tooLarge")
    return undated(`run.json is ${String(read.bytes)} bytes, over the cap`);
  if (read.kind === "unreadable")
    return undated(`run.json is unreadable (${read.code})`);
  const summary = readRecordSummary(read.text);
  if (summary === undefined) return undated("run.json is not a run record");
  if (summary.id !== name || summary.taskId !== taskId)
    return undated("run.json is another run's record");
  const time = isoInstant(summary.startedAt);
  if (!Number.isFinite(time)) return undated("run.json has no valid start");
  return {
    time,
    complete: summary.state === "ended",
    record: summary.state,
  };
}

/**
 * Lists the task's run folders in `runs/`. Only names that are exactly the task's run ids are looked
 * at; a link or a file under such a name is skipped, never followed, and so is a `run.json` that is a
 * link. Anything else in `runs/` — another task's, a removal's leftover — is not this listing's.
 *
 * @param runsDir - `<state>/runs`, absolute.
 * @param taskId - the task, a valid task id.
 * @returns the folders and the skipped entries; none when `runs/` does not exist.
 * @throws when `runs/` is a link or cannot be read.
 */
export async function listTaskRuns(
  runsDir: string,
  taskId: string,
): Promise<{ runs: RunFolder[]; skipped: SkippedEntry[] }> {
  const stats = await lstat(runsDir).catch((error: unknown) => {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  });
  if (stats === undefined) return { runs: [], skipped: [] };
  if (!stats.isDirectory())
    throw new Error(`${runsDir} is not a folder (a link is never followed)`);
  const skipped: SkippedEntry[] = [];
  const found = await Promise.all(
    (await readdir(runsDir)).sort().map(async (name) => {
      const number = runNumberOf(name, taskId);
      if (number === undefined) return undefined;
      const path = join(runsDir, name);
      const reason = await notARunFolder(path);
      if (reason !== undefined) {
        skipped.push({ path, reason });
        return undefined;
      }
      const read = await readCapped(
        join(path, RUN_FILES.record),
        MAX_RECORD_BYTES,
        { followLink: false },
      );
      const folder: RunFolder = {
        path,
        name,
        number,
        empty: false,
        ...recordDating(read, name, taskId),
      };
      return folder;
    }),
  );
  return {
    runs: found.filter((run) => run !== undefined),
    skipped: skipped.sort((a, b) => (a.path < b.path ? -1 : 1)),
  };
}

/** Why a path named like a run is no run folder to prune, or `undefined` when it is a real folder. */
async function notARunFolder(path: string): Promise<string | undefined> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) return "a symlink, never followed";
    return stats.isDirectory() ? undefined : "a file, not a run folder";
  } catch (error) {
    return `unreadable (${errorCode(error) ?? "unknown error"})`;
  }
}

/**
 * Prunes one task's run folders: lists them, plans by the policy with the run in progress and every
 * `running` record protected, removes what the plan deletes, then what interrupted removals left in
 * `runs/` once their grace has passed. Removal is `applyRetention`'s: renamed to a hidden name first,
 * never through a link, each folder re-checked to lead where it was listed, below the state directory.
 *
 * @param input - the state directory, the task, the cap, the run in progress and the time.
 * @returns what it did; a failure, listing included, is in `failed` — this never rejects.
 */
export async function pruneTaskRuns(
  input: RunRetentionInput,
): Promise<RunRetentionReport> {
  const { stateDir, taskId, now } = input;
  const runsDir = join(stateDir, RUNS_DIR);
  let policy = DEFAULT_RETENTION;
  try {
    policy = runRetentionPolicy(input.keep);
    if (!isAbsolute(stateDir))
      throw new RangeError("The state directory must be an absolute path.");
    if (!TASK_ID_PATTERN.test(taskId))
      throw new RangeError("The task id must be a task's id.");
    const listing = await listTaskRuns(runsDir, taskId);
    const running = listing.runs
      .filter((run) => run.record === "running")
      .map((run) => run.path);
    const plan = planRetention(listing.runs, policy, now, () => taskId, [
      ...(input.current === undefined ? [] : [input.current]),
      ...running,
    ]);
    const removal = applyRetention(plan, stateDir, now);
    // `runs/` is laid out as a report group is, so the suite's listing finds its leftovers.
    const leftovers = removeLeftovers(
      listGroupRuns(runsDir, RUNS_DIR).leftovers,
      stateDir,
      now,
    );
    return {
      policy,
      plan,
      removed: removal.removed,
      gone: removal.gone,
      leftovers: leftovers.removed,
      skipped: listing.skipped,
      failed: [...removal.failed, ...leftovers.failed],
    };
  } catch (error) {
    return {
      policy,
      plan: [],
      removed: [],
      gone: [],
      leftovers: [],
      skipped: [],
      failed: [{ path: runsDir, error: reasonOf(error) }],
    };
  }
}

/** An error in words: its system code, else its message. */
function reasonOf(error: unknown): string {
  return (
    errorCode(error) ?? (error instanceof Error ? error.message : String(error))
  );
}

/** One line of what a pruning did; `warn` when it is something to look at. */
export interface RunRetentionLine {
  readonly text: string;
  readonly warn: boolean;
}

/**
 * What a pruning did, in lines: one for what went, one per failure and per skipped entry; none when
 * nothing went and nothing needs looking at.
 *
 * @param report - the pruning's report.
 * @param show - how a path is shown (relative to the state directory, say).
 * @example
 * ```ts
 * describeRunRetention(report, show);
 * // [{ text: "pruned 1 run folder, 4.3 kB — beyond the newest 20 (runs.reportsKeep)", warn: false }]
 * ```
 */
export function describeRunRetention(
  report: RunRetentionReport,
  show: (path: string) => string,
): RunRetentionLine[] {
  const lines: RunRetentionLine[] = [];
  const counts = new Map<DeleteReason, number>();
  for (const { decision } of report.removed)
    if (decision.action === "delete")
      counts.set(decision.reason, (counts.get(decision.reason) ?? 0) + 1);
  const runs = report.removed.length;
  const leftovers = report.leftovers.length;
  if (runs > 0 || leftovers > 0) {
    const bytes = [...report.removed, ...report.leftovers].reduce(
      (sum, { bytes: size }) => sum + size,
      0,
    );
    const why = [...counts].map(([reason, count]) => {
      const words = describeReason(reason, report.policy);
      return `${String(count)} ${reason === "beyond-cap" ? `${words} (runs.reportsKeep)` : words}`;
    });
    if (leftovers > 0)
      why.push(`${String(leftovers)} left by an interrupted removal`);
    const total = runs + leftovers;
    lines.push({
      text: `pruned ${String(total)} run folder${total === 1 ? "" : "s"}, ${formatBytes(bytes)} — ${why.join(", ")}`,
      warn: false,
    });
  }
  for (const failure of report.failed)
    lines.push({
      text: `could not prune ${show(failure.path)} — ${failure.error}`,
      warn: true,
    });
  for (const entry of report.skipped)
    lines.push({
      text: `left ${show(entry.path)} alone — ${entry.reason}`,
      warn: true,
    });
  return lines;
}
