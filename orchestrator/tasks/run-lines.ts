import { isAbsolute, relative } from "node:path";

import type { TaskConfig } from "../config/schema";
import type {
  RunFinishedEvent,
  RunFinishedInput,
} from "../events/run-finished";
import { formatDuration } from "../notify/slack";
import type { RunOutcome, RunStatus, StopTaken } from "../runs/outcome";
import { STOP_RANK, type StopLevel } from "../runs/stop";
import { failureLine } from "../text";

/**
 * The pure parts of one run (`cycle.ts`): what its terminal lines say, what its `run.finished` is
 * told of its task, how far a stop asked for goes, and the outcome of a run whose end could not be
 * read. Each line is one line of the orchestrator's log; the logger masks it again.
 */

/** A task, as one run of it needs it. */
export type CycleTask = Pick<
  TaskConfig,
  "id" | "name" | "product" | "cell" | "plugin" | "grep"
>;

/** The longest failure a line or a reason quotes, in code points. */
export const MAX_FAILURE_LENGTH = 300;

/** Each status's mark in the outcome line. */
const MARKS: Readonly<Record<RunStatus, string>> = {
  passed: "✔",
  flaky: "⚠",
  failed: "✘",
  error: "✘",
  stopped: "■",
  killed: "■",
};

/** The statuses of a run that tested the plugin: its report says how, so the line points there. */
const TESTED: ReadonlySet<RunStatus> = new Set(["passed", "flaky", "failed"]);

/**
 * A path as a line shows it: relative to `base` when it is inside it (`.orchestrator/runs/bpng-12/run.log`
 * from the checkout), else as it is.
 *
 * @param path - an absolute path.
 * @param base - the folder it is shown from: the checkout.
 * @returns the path to show.
 */
export function showPath(path: string, base: string): string {
  const shown = relative(base, path);
  return shown === "" || shown.startsWith("..") || isAbsolute(shown)
    ? path
    : shown;
}

/**
 * The task as a `run.finished` names it: its ref only when it asks for one, its filter only when it
 * has one.
 *
 * @param task - the task.
 * @returns the event's task.
 */
export function eventTask(task: CycleTask): RunFinishedInput["task"] {
  return {
    id: task.id,
    product: task.product,
    cell: task.cell,
    ...(task.name === undefined ? {} : { name: task.name }),
    ...(task.plugin?.ref === undefined ? {} : { ref: task.plugin.ref }),
    ...(task.grep === undefined ? {} : { grep: task.grep }),
  };
}

/**
 * The line a run starts with: `bpng-12 started · backwpup pro@nginx · develop · .orchestrator/runs/bpng-12/run.log`
 * — the product's default ref when the task names none, its filter when it has one.
 *
 * @param id - the run's id.
 * @param task - its task.
 * @param log - its log, as shown.
 * @returns the line.
 */
export function startedLine(id: string, task: CycleTask, log: string): string {
  return [
    `${id} started`,
    `${task.product} ${task.cell}`,
    task.plugin?.ref ?? "default ref",
    ...(task.grep === undefined ? [] : [task.grep]),
    log,
  ].join(" · ");
}

/**
 * The line a run ends with: `bpng-12 ✔ passed · 52 scenarios: 51 passed, 1 flaky · 54m 10s · reports/…`.
 * A run that tested points at its report; one that did not says why and points at its log.
 *
 * @param event - the run's `run.finished`.
 * @param show - how a path is shown ({@link showPath}).
 * @returns the line.
 */
export function outcomeLine(
  event: RunFinishedEvent,
  show: (path: string) => string,
): string {
  const tested = TESTED.has(event.status);
  return [
    `${event.run.id} ${MARKS[event.status]} ${event.status}`,
    ...(event.counts.total === 0 ? [] : [countsText(event.counts)]),
    ...(event.reason === null ? [] : [event.reason]),
    formatDuration(event.durationMs),
    show(tested ? event.report.dir : event.report.log),
  ].join(" · ");
}

/**
 * `52 scenarios: 51 passed, 1 flaky` — each count only when not 0.
 *
 * @param counts - the run's counts.
 * @returns the text.
 */
function countsText(counts: RunFinishedEvent["counts"]): string {
  const parts = (
    [
      [counts.passed, "passed"],
      [counts.flaky, "flaky"],
      [counts.failed, "failed"],
      [counts.skipped, "skipped"],
      [counts.didNotRun, "did not run"],
    ] as const
  )
    .filter(([count]) => count > 0)
    .map(([count, label]) => `${String(count)} ${label}`);
  const total = `${String(counts.total)} scenario${counts.total === 1 ? "" : "s"}`;
  return parts.length === 0 ? total : `${total}: ${parts.join(", ")}`;
}

/**
 * The stop that goes further of two: the one already asked for, or a new one.
 *
 * @param asked - the stop asked for so far, if any.
 * @param next - the new one.
 * @returns the further; the earlier on a tie, so its reason stays.
 */
export function furtherStop<S extends { readonly level: StopLevel }>(
  asked: S | undefined,
  next: S,
): S {
  return asked !== undefined && STOP_RANK[asked.level] >= STOP_RANK[next.level]
    ? asked
    : next;
}

/**
 * The outcome of a run whose end could not be read: what its stop says when it was stopped — a kill
 * is `killed`, any other stop `stopped` —, else `error` with why.
 *
 * @param stop - how far it was stopped.
 * @param failure - what reading its end threw.
 * @param secrets - the secret values to mask in the reason.
 * @returns the outcome.
 */
export function unreadOutcome(
  stop: StopTaken,
  failure: unknown,
  secrets: readonly string[],
): RunOutcome {
  if (stop.level === "killed") return { status: "killed", reason: stop.why };
  if (stop.level !== "none") return { status: "stopped", reason: stop.why };
  return {
    status: "error",
    reason: `its end could not be read: ${failureLine(failure, MAX_FAILURE_LENGTH, secrets)}`,
  };
}

/**
 * The outcome of a run that could not start: nothing ran, so it could not test.
 *
 * @param failure - what kept it from starting.
 * @param secrets - the secret values to mask in the reason.
 * @returns the outcome.
 */
export function notStartedOutcome(
  failure: unknown,
  secrets: readonly string[],
): RunOutcome {
  return {
    status: "error",
    reason: `the run could not start: ${failureLine(failure, MAX_FAILURE_LENGTH, secrets)}`,
  };
}
