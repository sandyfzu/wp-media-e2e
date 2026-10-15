import { lstat, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, sep } from "node:path";

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
  type RemovalLeftover,
  type RemovalReport,
  type RetentionDecision,
  type RetentionEntry,
  type RetentionPolicy,
  type SkippedEntry,
} from "../../src/common/reporting/retention";
import { TASK_ID_PATTERN } from "../config/schema";
import { errorCode } from "../error-code";
import { RUN_FILES, RUNS_DIR, runIdOf } from "../runs/identity";
import {
  readRunRecordFile,
  type RecordFileRead,
  type RunState,
} from "../runs/record";
import { textOf } from "../text";
import { StateError } from "./errors";
import { checkRunsFolder } from "./runs-folder";

/**
 * Run-folder retention: a task's `runs/<task>-<n>/` folders pruned by the suite's own report policy
 * (`planRetention`, `applyRetention`), one task a group — the cap is `runs.reportsKeep`, as for its
 * reports. Each folder is dated by its record's `startedAt`, never a modification time, and only a
 * record of that very folder dates it (`readRunRecordFile`, the orphan check's reader too); any other
 * folder is undated, which the policy always keeps — and which the report's lines count, since only a
 * person can clear it. Never throws: everything that went wrong is in the report, for the caller to
 * log.
 *
 * - **complete** — the record says `ended`: the run's log and outcome were written to the end, so the
 *   newest such folder is the one a person reads, and the policy keeps it longest. A `lost` run is
 *   dated, never complete.
 * - **empty** — never: a run folder holds a run the orchestrator started, and even one that tested
 *   nothing (`bddgen` failing, no scenario matching) has a log that says why. An empty entry would go
 *   whatever its age.
 * - **protected** — the run in progress, and every folder whose record still says `running`: a run in
 *   progress or an orphan, whose processes may still write its log and read its stop file — the drain
 *   needs that folder to exist. The orphan check rewrites one that is over as `lost`, after which it is
 *   pruned like any other.
 */

/** One of a task's run folders, as the planner sees it. */
export interface RunFolder extends RetentionEntry {
  /** The folder's name, the run's id: `bpng-12`. */
  readonly name: string;
  /** The run's number in its task. */
  readonly number: number;
  /** What its record says, or `unread` when none dates it ({@link RunFolder.undated}). */
  readonly record: RunState | "unread";
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
  /** The time to measure ages against, epoch ms: a finite number. */
  readonly now: number;
}

/** What a pruning needs besides the file system it prunes: injected, so a failure is tested. */
export interface RunRetentionDeps {
  /** Lists what interrupted removals left in `runs/`; the suite's report listing by default. */
  readonly listLeftovers?: (runsDir: string) => readonly RemovalLeftover[];
}

/** What one pruning did. */
export interface RunRetentionReport {
  /** The policy it applied. */
  readonly policy: RetentionPolicy;
  /** Every folder's fate, newest first. */
  readonly plan: readonly RetentionDecision<RunFolder>[];
  /** The folders it removed, each with its decision and the bytes it freed. */
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
 * the policy — when the record is missing, unreadable, too large, not a record, or another folder's.
 * Its task needs no check: a record names its folder, whose name is the task's id and a number, and a
 * record's id is always its own task's.
 *
 * @param read - the folder's `run.json`, read and sorted (`readRunRecordFile`).
 * @returns its start (`NaN` when undated), whether it ended, and why it is undated.
 */
export function recordDating(
  read: RecordFileRead,
): Pick<RunFolder, "time" | "complete" | "record" | "undated"> {
  switch (read.kind) {
    case "running":
    case "over":
      return {
        time: isoInstant(read.record.startedAt),
        complete: read.record.state === "ended",
        record: read.record.state,
      };
    case "missing":
      return undated("no run.json");
    case "tooLarge":
      return undated(`run.json is ${String(read.bytes)} bytes, over the cap`);
    case "unreadable":
      return undated(`run.json is unreadable (${read.code})`);
    case "malformed":
      return undated(`run.json is ${read.why}`);
  }
}

/**
 * An undated folder's dating.
 *
 * @param why - why its record does not date it.
 * @returns the fields that mark it undated: never pruned, with `why` kept for the report.
 */
function undated(
  why: string,
): Pick<RunFolder, "time" | "complete" | "record" | "undated"> {
  return { time: Number.NaN, complete: false, record: "unread", undated: why };
}

/**
 * Lists the task's run folders in `runs/`, one at a time — so a `runs/` of thousands never holds
 * thousands of files open at once. Only names that are exactly the task's run ids are looked at; a
 * link or a file under such a name is skipped, never followed, and so is a `run.json` that is a link.
 * Anything else in `runs/` — another task's, a removal's leftover — is not this listing's.
 *
 * @param runsDir - `<state>/runs`, absolute.
 * @param taskId - the task, a valid task id.
 * @returns the folders and the skipped entries, by name; none when `runs/` does not exist.
 * @throws when `runs/` is a link or cannot be read.
 */
export async function listTaskRuns(
  runsDir: string,
  taskId: string,
): Promise<{ runs: RunFolder[]; skipped: SkippedEntry[] }> {
  if (!(await checkRunsFolder(runsDir))) return { runs: [], skipped: [] };
  const runs: RunFolder[] = [];
  const skipped: SkippedEntry[] = [];
  for (const name of (await readdir(runsDir)).sort()) {
    const number = runNumberOf(name, taskId);
    if (number === undefined) continue;
    const path = join(runsDir, name);
    const reason = await notARunFolder(path);
    if (reason !== undefined) {
      skipped.push({ path, reason });
      continue;
    }
    const read = await readRunRecordFile(join(path, RUN_FILES.record), name);
    runs.push({ path, name, number, empty: false, ...recordDating(read) });
  }
  return { runs, skipped };
}

/**
 * Why a path named like a run is no run folder to prune.
 *
 * @param path - the path.
 * @returns why, or `undefined` when it is a real folder.
 */
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
 * @param deps - how leftovers are listed; the suite's listing by default.
 * @returns what it did; a failure, listing included, is in `failed` — this never rejects.
 */
export async function pruneTaskRuns(
  input: RunRetentionInput,
  deps: RunRetentionDeps = {},
): Promise<RunRetentionReport> {
  const { stateDir, taskId, now } = input;
  const runsDir = join(stateDir, RUNS_DIR);
  let policy = DEFAULT_RETENTION;
  let plan: RetentionDecision<RunFolder>[];
  let skipped: SkippedEntry[];
  let removal: RemovalReport<RunFolder>;
  try {
    policy = runRetentionPolicy(input.keep);
    if (!isAbsolute(stateDir))
      throw new RangeError("The state directory must be an absolute path.");
    if (!TASK_ID_PATTERN.test(taskId))
      throw new RangeError("The task id must be a task's id.");
    // An infinite time would make every run too old, the newest complete one included; `NaN`, every
    // removal's leftover past its grace.
    if (!Number.isFinite(now))
      throw new RangeError("The time to prune at must be a finite number.");
    const listing = await listTaskRuns(runsDir, taskId);
    skipped = listing.skipped;
    const running = listing.runs
      .filter((run) => run.record === "running")
      .map((run) => run.path);
    plan = planRetention(listing.runs, policy, now, () => taskId, [
      ...(input.current === undefined ? [] : [input.current]),
      ...running,
    ]);
    removal = applyRetention(plan, stateDir, now);
  } catch (error) {
    return { ...nothingDone(policy), failed: [failure(runsDir, error)] };
  }
  const leftovers = removeLeftoversIn(
    runsDir,
    stateDir,
    now,
    deps.listLeftovers ?? listLeftovers,
  );
  return {
    policy,
    plan,
    removed: removal.removed,
    gone: removal.gone,
    leftovers: leftovers.removed,
    skipped,
    failed: [...removal.failed, ...leftovers.failed],
  };
}

/**
 * Removes what interrupted removals left in `runs/`. On its own: a failure here never loses what was
 * already removed.
 *
 * @param runsDir - `<state>/runs`.
 * @param stateDir - the root every removal stays below.
 * @param now - the time, epoch ms.
 * @param list - lists the leftovers.
 * @returns what went and what failed, the listing's own failure included.
 */
function removeLeftoversIn(
  runsDir: string,
  stateDir: string,
  now: number,
  list: (runsDir: string) => readonly RemovalLeftover[],
): ReturnType<typeof removeLeftovers> {
  try {
    return removeLeftovers(list(runsDir), stateDir, now);
  } catch (error) {
    return { removed: [], failed: [failure(runsDir, error)] };
  }
}

/**
 * The leftovers in `runs/`, laid out as a report group is, so the suite's own listing finds them.
 *
 * @param runsDir - `<state>/runs`.
 * @returns what interrupted removals left there, as the suite's report listing names it.
 * @throws what the listing throws: `runs/` a link, or unreadable.
 */
function listLeftovers(runsDir: string): readonly RemovalLeftover[] {
  return listGroupRuns(runsDir, RUNS_DIR).leftovers;
}

/**
 * A report of a pruning that did nothing.
 *
 * @param policy - the policy it would have applied.
 * @returns a report with every list empty.
 */
function nothingDone(policy: RetentionPolicy): RunRetentionReport {
  return {
    policy,
    plan: [],
    removed: [],
    gone: [],
    leftovers: [],
    skipped: [],
    failed: [],
  };
}

/**
 * A failure on `path`, in words: a refusal's own message (a {@link StateError}, which names its
 * repair), else the error's system code, else its message.
 *
 * @param path - what it was about.
 * @param error - what was thrown.
 * @returns the failure.
 */
function failure(path: string, error: unknown): RemovalFailure {
  return {
    path,
    error:
      error instanceof StateError
        ? textOf(error)
        : (errorCode(error) ?? textOf(error)),
  };
}

/** One line of what a pruning did; `warn` when it is something to look at. */
export interface RunRetentionLine {
  readonly text: string;
  readonly warn: boolean;
}

/**
 * What a pruning did, in lines: one for what went; one per failure and per skipped entry; one for the
 * folders kept because nothing dates them, with the first one's reason — none of them ever goes, so
 * only a person can clear them. None when nothing went and nothing needs looking at.
 *
 * @param report - the pruning's report.
 * @param show - how a path is shown (relative to the state directory, say); applied to the paths a
 *   failure's system error quotes too.
 * @returns the lines, in that order; empty when there is nothing to say.
 * @example
 * ```ts
 * describeRunRetention(report, show);
 * // [{ text: "pruned 1 run folder, 4.3 kB — 1 beyond the newest 20 (runs.reportsKeep)", warn: false }]
 * ```
 */
export function describeRunRetention(
  report: RunRetentionReport,
  show: (path: string) => string,
): RunRetentionLine[] {
  const lines: RunRetentionLine[] = [];
  const pruned = prunedLine(report);
  if (pruned !== undefined) lines.push({ text: pruned, warn: false });
  for (const failure of report.failed)
    lines.push({
      text: `could not prune ${show(failure.path)} — ${failureWords(failure, show)}`,
      warn: true,
    });
  for (const entry of report.skipped)
    lines.push({
      text: `left ${show(entry.path)} alone — ${entry.reason}`,
      warn: true,
    });
  const undated = report.plan.filter(
    (decision) => decision.reason === "undated",
  );
  const first = undated[0]?.entry;
  if (first !== undefined)
    lines.push({
      text:
        `kept ${String(undated.length)} run folder${undated.length === 1 ? "" : "s"} that nothing ` +
        `dates, never pruned — ${show(first.path)}: ${first.undated ?? "undated"}`,
      warn: true,
    });
  return lines;
}

/**
 * The line saying what went, or `undefined` when nothing did.
 *
 * @param report - the pruning's report.
 * @returns `pruned N run folders, <size> — <counts by reason>`, or `undefined`.
 */
function prunedLine(report: RunRetentionReport): string | undefined {
  const runs = report.removed.length;
  const leftovers = report.leftovers.length;
  if (runs === 0 && leftovers === 0) return undefined;
  const counts = new Map<DeleteReason, number>();
  for (const { decision } of report.removed)
    if (decision.action === "delete")
      counts.set(decision.reason, (counts.get(decision.reason) ?? 0) + 1);
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
  return `pruned ${String(total)} run folder${total === 1 ? "" : "s"}, ${formatBytes(bytes)} — ${why.join(", ")}`;
}

/** What the suite says of a removal's remainder; a later prune tries it again, but may fail again. */
const LATER_PRUNE = ", which a later prune removes";

/**
 * A failure's words for a line: every path its system error quotes below the failed path's folder
 * shown as the line shows paths, a path Node repeats (`…: /a/b '/a/b'`) said once, and a remainder's
 * later removal promised no more than it is.
 *
 * @param failure - the failure.
 * @param show - how a path is shown.
 * @returns the failure's error, so rewritten.
 */
function failureWords(
  failure: RemovalFailure,
  show: (path: string) => string,
): string {
  const folder = dirname(failure.path);
  return failure.error
    .replaceAll(`${folder}${sep}`, `${show(folder)}${sep}`)
    .replace(/(\S+) '\1'/g, "$1")
    .replace(LATER_PRUNE, ", which a later prune tries again");
}
