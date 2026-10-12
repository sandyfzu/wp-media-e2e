import type { SetupKind } from "../config/project-names";
import type { Counts, FirstError, TestStatus } from "./results";

/**
 * The results stream's schema, version 1: one JSON object per line of `<report dir>/results.jsonl`,
 * written as a run goes (`results-stream.ts`) and read by whoever watches it — the orchestrator, the
 * report pruning (`results-reader.ts`).
 *
 * Every line has `v`, `type` and `at`. A reader ignores a type or a field it does not know; a change
 * that would mislead an existing reader bumps {@link RESULTS_SCHEMA_VERSION} instead.
 *
 * A stream with no `run.end` belongs to a runner that died (its exit code says how); no file at all
 * means Playwright never started.
 *
 * As sensitive as the reports: an error's message quotes what an assertion compared (an input's value
 * included), though never Playwright's call log, whose element markup carries attribute values.
 */

/** The schema's version, the `v` of every line. */
export const RESULTS_SCHEMA_VERSION = 1;

/** The stream's file name, inside the run's report folder. */
export const RESULTS_FILE = "results.jsonl";

/** What every line carries. */
interface EventBase {
  /** {@link RESULTS_SCHEMA_VERSION}. */
  readonly v: typeof RESULTS_SCHEMA_VERSION;
  /** When the line was written, ISO 8601. */
  readonly at: string;
}

/**
 * The run began. `mode` is `list` for `--list`, which runs nothing: such a run — like one that found
 * no tests (`scenarios.total` and `setups.total` both 0) — still leaves a report folder.
 */
export interface RunBeginEvent extends EventBase {
  readonly type: "run.begin";
  readonly runId: string;
  readonly product: string;
  /** The one cell the run targets; absent for a run of every cell. */
  readonly cell?: string;
  /** The cell's edition, for an edition-ful product. */
  readonly edition?: string;
  readonly mode: "test" | "list";
  /** How many scenarios the run plans (after `--grep`). */
  readonly scenarios: number;
  /** How many setup tests it plans — counted whatever `--grep` says. */
  readonly setups: number;
  /** The retries a failed scenario gets. */
  readonly retries: number;
  /** The workers the run starts. */
  readonly workers: number;
}

/** A setup test finished, for good. A failed one means its cell's scenarios never run. */
export interface SetupEndEvent extends EventBase {
  readonly type: "setup.end";
  /** Playwright's test id: stable across runs of one cell, different across cells. */
  readonly id: string;
  readonly project: string;
  readonly setup: SetupKind;
  readonly status: TestStatus;
  readonly attempts: number;
  /** Every attempt's duration, summed. */
  readonly durationMs: number;
  /** Present, `true`, when a retry was due but never ran — as for `scenario.end`. */
  readonly retryNotRun?: true;
  /** The first error, when it failed or was interrupted. */
  readonly error?: FirstError;
}

/** A scenario's attempt began: what is running now, and since when. */
export interface ScenarioBeginEvent extends EventBase {
  readonly type: "scenario.begin";
  readonly id: string;
  readonly project: string;
  readonly feature: string;
  readonly scenario: string;
  /** 1 for the first attempt, 2 for the first retry, … */
  readonly attempt: number;
  /**
   * The worker slot — which of the cell's sites the attempt runs on; `-1` for an attempt Playwright
   * ended without running it in a worker (a `beforeAll` that failed, a crashed worker), which then
   * ends at once as `skipped` or `failed`.
   */
  readonly parallelIndex: number;
}

/**
 * A scenario's attempt did not pass, and Playwright is due to run it again. Should the retry never
 * run, the scenario's `scenario.end` says so (`retryNotRun`).
 */
export interface ScenarioRetryEvent extends EventBase {
  readonly type: "scenario.retry";
  readonly id: string;
  readonly attempt: number;
  /**
   * The attempt's own status: `failed` or `timedOut` — or `skipped`, for an attempt Playwright ended
   * without running it (a `beforeAll` that failed, a crashed worker), which it then retries.
   */
  readonly attemptStatus: string;
  readonly durationMs: number;
  readonly error?: FirstError;
}

/**
 * A scenario finished, for good: written once per scenario as its last attempt ends — or, for one
 * whose due retry never ran, as the run ends, before `run.end`. Should Playwright run a scenario again
 * after its end (it re-runs passed tests only in a serial-mode suite, which no feature is), the later
 * `scenario.end` is the true one: a reader keeps the last for each `id`.
 */
export interface ScenarioEndEvent extends EventBase {
  readonly type: "scenario.end";
  readonly id: string;
  readonly project: string;
  readonly feature: string;
  readonly scenario: string;
  /** The Rule and Scenario Outline titles between the Feature and the scenario. */
  readonly path: readonly string[];
  /** The `.feature` file, relative to the repository. */
  readonly file?: string;
  readonly tags: readonly string[];
  readonly status: TestStatus;
  /** Playwright's own outcome, verbatim. */
  readonly outcome: string;
  readonly attempts: number;
  /** Every attempt's duration, summed. */
  readonly durationMs: number;
  /** Present, `true`, when the drain skipped it: the run was being stopped. */
  readonly drained?: true;
  /**
   * Present, `true`, when a retry was due but never ran: the run stopped first (an interrupt,
   * `--max-failures`, its time limit), or Playwright judged the error not worth retrying (a screenshot
   * with no baseline). Its `status` is what its attempts so far give it.
   */
  readonly retryNotRun?: true;
  /** The last attempt's first error — only for a scenario that failed or was interrupted. */
  readonly error?: FirstError;
}

/** The run ended. Absent when the runner died. */
export interface RunEndEvent extends EventBase {
  readonly type: "run.end";
  /** Playwright's status for the run. */
  readonly status: "passed" | "failed" | "timedout" | "interrupted";
  readonly durationMs: number;
  readonly scenarios: Counts;
  readonly setups: Counts;
}

/** An error outside any test: a config or a worker failing, "No tests found". */
export interface RunErrorEvent extends EventBase {
  readonly type: "run.error";
  readonly message: string;
}

/** Every line of a version 1 stream. */
export type ResultsEvent =
  | RunBeginEvent
  | SetupEndEvent
  | ScenarioBeginEvent
  | ScenarioRetryEvent
  | ScenarioEndEvent
  | RunEndEvent
  | RunErrorEvent;

/** Every event type, as a reader checks it. */
export const RESULTS_EVENT_TYPES: ReadonlySet<ResultsEvent["type"]> = new Set([
  "run.begin",
  "setup.end",
  "scenario.begin",
  "scenario.retry",
  "scenario.end",
  "run.end",
  "run.error",
]);
