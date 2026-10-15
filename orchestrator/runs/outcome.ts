import { oneLine, safeLine } from "../text";
import type { SetupFailureFact } from "./facts";
import { scenarioCounts, type RunResults } from "./results";

/**
 * How a run ended, decided once it has: one status and, when it did not test the plugin, why. Pure —
 * from how its processes exited, how far the orchestrator went to stop it, its results stream and the
 * failed setups its facts name.
 *
 * The rows, first match wins:
 *
 * | When | Status |
 * | --- | --- |
 * | the orchestrator killed it | `killed` |
 * | it was stopped: interrupted while it tested, or drained before it finished — by the orchestrator or not | `stopped` |
 * | `bddgen` failed; Playwright ended without `run.end`; a setup failed; the run's time limit; an error outside any test; no scenario ran; Playwright's status or exit code the scenarios do not explain | `error` |
 * | a scenario failed | `failed` |
 * | a scenario was flaky | `flaky` |
 * | otherwise | `passed` |
 *
 * Only `passed`, `flaky` and `failed` say how the plugin did: the rest say the run could not tell.
 */

/** A run's status. */
export type RunStatus =
  "passed" | "flaky" | "failed" | "error" | "stopped" | "killed";

/** How a process ended: its exit code, or the signal that ended it. */
export interface ProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

/**
 * How far the orchestrator went to stop a run: not at all, the drain (the stop file), one SIGINT, or
 * SIGKILL to its process group — with why it was stopped, said in the reason.
 */
export type StopTaken =
  | { readonly level: "none" }
  | {
      readonly level: "drained" | "interrupted" | "killed";
      /** Why: `"the orchestrator was stopped (SIGINT)"`. */
      readonly why: string;
    };

/** What a run's outcome is decided from. */
export interface OutcomeInput {
  readonly stop: StopTaken;
  readonly bddgen: ProcessExit;
  /** Absent when Playwright never started: `bddgen` failed, or the run was stopped before. */
  readonly playwright?: ProcessExit;
  /** The results stream; absent when there is none. */
  readonly results?: RunResults;
  /** Why the stream was not read though it is there (`it is over 32 MiB`); absent otherwise. */
  readonly resultsUnread?: string;
  /** The failed setups the run's facts name, in order; their first error's first line each. */
  readonly setupFailures: readonly SetupFailureFact[];
  /** The run log's last lines, for a reason nothing else explains. */
  readonly logTail: readonly string[];
  /** The secret values the orchestrator holds, masked in the reason wherever they appear. */
  readonly secrets: readonly string[];
}

/** A run's outcome. */
export interface RunOutcome {
  readonly status: RunStatus;
  /** Why, for `error`, `stopped` and `killed`: one line. */
  readonly reason?: string;
}

/** The longest reason, in code points: one line in a terminal, a Slack message, a record. */
export const MAX_REASON_LENGTH = 500;

/** How many of the log's last lines a reason quotes when nothing else explains the end. */
export const LOG_TAIL_LINES = 3;

/**
 * Decides a run's outcome.
 *
 * @param input - how the run's processes ended, the stop, the results and the failed setups.
 * @returns the status, and the reason when it is not a result of the plugin's.
 */
export function runOutcome(input: OutcomeInput): RunOutcome {
  const { stop, results, secrets } = input;
  if (stop.level === "killed") return outcome("killed", stop.why, secrets);
  const stopped = stopReason(input);
  if (stopped !== undefined) return outcome("stopped", stopped, secrets);
  const error = errorReason(input);
  if (error !== undefined) return outcome("error", error, secrets);
  // `errorReason` returns a reason whenever `results` is absent.
  const counts = scenarioCounts(results ?? EMPTY_RESULTS);
  if (counts.failed > 0) return { status: "failed" };
  if (counts.flaky > 0) return { status: "flaky" };
  return { status: "passed" };
}

/** A stream with nothing in it. */
const EMPTY_RESULTS: RunResults = {
  setups: [],
  scenarios: [],
  runErrors: [],
};

/**
 * Why the run counts as stopped, if it does: the orchestrator interrupted it, or drained it before it
 * finished every scenario; or it ended interrupted or drained without the orchestrator asking —
 * someone signalled it by hand. A stop that came too late to change anything is no stop: a drain
 * asked for as the last scenario ended, or an interrupt asked for once the tests were over — which
 * the launch then does not send — while the runner still ended on its own. That run is judged by its
 * results.
 *
 * @param input - the outcome's input.
 * @returns the reason, or `undefined` when it was not stopped.
 */
function stopReason(input: OutcomeInput): string | undefined {
  const { stop, results } = input;
  const interrupted = results?.end?.status === "interrupted";
  const drained = results !== undefined && scenarioCounts(results).drained > 0;
  // A complete run — every scenario ran, none was cut — whose results still count.
  const finished = results?.end !== undefined && !interrupted && !drained;
  if (stop.level === "interrupted") {
    // A runner a signal ended did not finish its reports, whatever its stream says.
    const endedOnItsOwn = input.playwright?.signal === null;
    if (!finished || !endedOnItsOwn) return stop.why;
  }
  if (stop.level === "drained" && !finished) return stop.why;
  if (interrupted) return "interrupted from outside the orchestrator";
  if (drained) return "drained from outside the orchestrator";
  return undefined;
}

/**
 * Why the run could not test the plugin, if it could not.
 *
 * @param input - the outcome's input.
 * @returns the reason, or `undefined` when it tested.
 */
function errorReason(input: OutcomeInput): string | undefined {
  const { bddgen, playwright, results } = input;
  if (!isSuccess(bddgen))
    return `bddgen ${describeExit(bddgen)}${fromLog(input.logTail, input.secrets, true)}`;
  if (playwright === undefined) return "Playwright never started";
  if (results === undefined && input.resultsUnread !== undefined)
    return `Playwright ${describeExit(playwright)}, and its results could not be read: ${input.resultsUnread}`;
  if (results?.end === undefined)
    return `Playwright ${describeExit(playwright)} without finishing its results${fromLog(input.logTail, input.secrets)}`;
  const setup = failedSetup(input);
  if (setup !== undefined) return setup;
  // Checked before the run's errors: the time limit also writes one, which says less.
  if (results.end.status === "timedout")
    return "the run reached its time limit";
  const runError = results.runErrors.find(
    (message) => !isNoTestsFound(message),
  );
  if (runError !== undefined) return `an error outside any test: ${runError}`;
  const counts = scenarioCounts(results);
  if (counts.passed + counts.failed + counts.flaky === 0)
    return counts.total === 0
      ? "no scenario ran: none matched"
      : `no scenario ran: ${String(counts.total)} planned, none passed or failed`;
  // Playwright fails a run only for a failed test or an error outside any; no such error was written.
  if (results.end.status === "failed" && counts.failed === 0)
    return "Playwright says the run failed, though no scenario failed";
  // A clean exit is 0 for a passed run and 1 for a failed one; anything else is the runner's own.
  const expected = results.end.status === "passed" ? 0 : 1;
  if (playwright.code !== expected)
    return `Playwright ${describeExit(playwright)}, though its results say it ${results.end.status}${fromLog(input.logTail, input.secrets)}`;
  return undefined;
}

/**
 * Whether a run error is Playwright's "No tests found" — written when nothing matched the filter,
 * which is no error of the run's: the suite's own rule (`isNoTestsFound`), which its summary applies
 * and its stream does not.
 *
 * @param message - the run error's message.
 * @returns `true` when the message, made one line, opens with Playwright's `No tests found`.
 */
export function isNoTestsFound(message: string): boolean {
  return /^(?:Error: )?No tests found\b/.test(oneLine(message));
}

/**
 * The first failed setup, as a reason: the facts' first line of its error, else the stream's.
 *
 * @param input - the outcome's input.
 * @returns the reason, or `undefined` when every setup passed or was skipped.
 */
function failedSetup(input: OutcomeInput): string | undefined {
  const [fact] = input.setupFailures;
  if (fact !== undefined)
    return `the ${fact.setup} setup failed: ${fact.message}`;
  const failed = input.results?.setups.find(
    (setup) => setup.status === "failed" || setup.status === "interrupted",
  );
  if (failed === undefined)
    return (input.results?.end?.setups.failed ?? 0) > 0
      ? "a setup failed"
      : undefined;
  const message = failed.error?.message;
  return `the ${failed.setup} setup failed${message === undefined ? "" : `: ${message}`}`;
}

/**
 * Whether a process exited `0`.
 *
 * @param exit - how it ended.
 * @returns `true` only for code `0` and no signal.
 */
function isSuccess(exit: ProcessExit): boolean {
  return exit.code === 0 && exit.signal === null;
}

/**
 * How a process ended, as a phrase: `exited with code 1`, `was ended by SIGKILL`.
 *
 * @param exit - how it ended.
 * @returns the phrase, the signal first when there is one.
 */
export function describeExit(exit: ProcessExit): string {
  if (exit.signal !== null) return `was ended by ${exit.signal}`;
  return exit.code === null ? "ended" : `exited with code ${String(exit.code)}`;
}

/**
 * What the log adds to a reason: the first line naming an error when `preferError` and one does,
 * else its last {@link LOG_TAIL_LINES} lines; nothing when it is empty.
 *
 * @param tail - the log's last lines.
 * @param secrets - the secret values to mask.
 * @param preferError - whether the first error line says more than the end (`bddgen`'s does).
 * @returns `: <lines>`, or `""`.
 */
function fromLog(
  tail: readonly string[],
  secrets: readonly string[],
  preferError = false,
): string {
  // Each line made safe on its own: masked before and after it is cleaned, as a whole reason is.
  const lines = tail
    .map((line) => safeLine(line, MAX_REASON_LENGTH, secrets))
    .filter((line) => line !== "");
  const errorLine = preferError
    ? lines.find((line) => /\berror\b/i.test(line))
    : undefined;
  const quoted = errorLine ?? lines.slice(-LOG_TAIL_LINES).join(" · ");
  return quoted === "" ? "" : `: ${quoted}`;
}

/**
 * An outcome with its reason made one safe line ({@link safeLine}): credentials masked by shape and
 * by value, at most {@link MAX_REASON_LENGTH} code points.
 *
 * @param status - the status.
 * @param reason - why.
 * @param secrets - the secret values to mask.
 * @returns the outcome, its reason masked and cut.
 */
function outcome(
  status: RunStatus,
  reason: string,
  secrets: readonly string[],
): RunOutcome {
  return { status, reason: safeLine(reason, MAX_REASON_LENGTH, secrets) };
}
