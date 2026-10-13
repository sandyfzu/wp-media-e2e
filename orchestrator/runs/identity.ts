import { isAbsolute, join, resolve } from "node:path";

import { formatRunId, runReportDir } from "../../src/common/config/run-id";
import { DEFAULT_REPORT_ROOT } from "../../src/common/reporting/retention";
import { TASK_ID_PATTERN } from "../config/schema";

/**
 * Who a run is and where everything it leaves lives: its id (`bpng-12`), its `RUN_ID`, its own
 * folder in the state directory and its report folder in the checkout. Pure — the counter that hands
 * out the number is the state's.
 */

/** The state directory's folder of run folders. */
export const RUNS_DIR = "runs";

/** A run folder's files: the processes' output, the run's record, and the drain's stop file. */
export const RUN_FILES = {
  log: "run.log",
  record: "run.json",
  stop: "stop",
} as const;

/** Everything that names a run, and every path it uses — all absolute. */
export interface RunIdentity {
  /** The task's id and the run's number: `bpng-12`. */
  readonly id: string;
  /** `RUN_ID`: when the run started, then its id — the name of its report folder. */
  readonly runId: string;
  readonly startedAt: Date;
  /** `<state>/runs/<id>/`. */
  readonly dir: string;
  readonly log: string;
  readonly record: string;
  /** The drain's stop file: created to stop the run, never there before. */
  readonly stopFile: string;
  /** `<checkout>/reports/<product>/<cell>/<RUN_ID>/`: where the suite writes its reports. */
  readonly reportDir: string;
}

/** What a run's identity is made from. */
export interface RunIdentityInput {
  readonly taskId: string;
  readonly product: string;
  readonly cell: string;
  /** The run's number in its task, from 1. */
  readonly number: number;
  readonly startedAt: Date;
  /** The state directory: absolute. */
  readonly stateDir: string;
  /** The checkout the runs start in: absolute. */
  readonly checkout: string;
}

/**
 * A run's id: its task's id and its number, `bpng-12`. One folder-name-safe word, so it is also the
 * `RUN_ID`'s suffix.
 *
 * @param taskId - the task's id.
 * @param number - the run's number in its task, from 1.
 * @returns the id.
 * @throws {@link RangeError} for an id that is not a task's, or a number that is not a positive
 *   safe integer.
 */
export function runIdOf(taskId: string, number: number): string {
  if (!TASK_ID_PATTERN.test(taskId))
    throw new RangeError("A run's task id must be a task's id.");
  if (!Number.isSafeInteger(number) || number < 1)
    throw new RangeError(
      `A run's number must be a whole number from 1, got ${String(number)}.`,
    );
  return `${taskId}-${String(number)}`;
}

/**
 * A run's identity.
 *
 * @param input - the task, the run's number and start, and the two directories.
 * @returns the identity, every path absolute.
 * @throws {@link RangeError} for a relative directory, or what {@link runIdOf} and `formatRunId`
 *   refuse.
 */
export function runIdentity(input: RunIdentityInput): RunIdentity {
  if (!isAbsolute(input.stateDir) || !isAbsolute(input.checkout))
    throw new RangeError(
      "A run's state directory and checkout must be absolute paths.",
    );
  const id = runIdOf(input.taskId, input.number);
  const runId = formatRunId(input.startedAt, id);
  const dir = join(input.stateDir, RUNS_DIR, id);
  return {
    id,
    runId,
    startedAt: input.startedAt,
    dir,
    log: join(dir, RUN_FILES.log),
    record: join(dir, RUN_FILES.record),
    stopFile: join(dir, RUN_FILES.stop),
    // The runs never get the suite's `REPORT_ROOT`, so they report under its default.
    reportDir: resolve(
      input.checkout,
      runReportDir(DEFAULT_REPORT_ROOT, input.product, input.cell, runId),
    ),
  };
}
