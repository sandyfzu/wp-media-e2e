import { isAbsolute, relative, sep } from "node:path";
import { stripVTControlCharacters } from "node:util";

import type { TestCase, TestResult } from "@playwright/test/reporter";

import { STOPPED_ANNOTATION } from "../config/drain";
import { setupKindOf, type SetupKind } from "../config/project-names";

/**
 * What a run's results are, decided from Playwright's reporter API: each test's final status, the
 * first error a failure shows, where the scenario sits in its feature, and the run's counts. Pure —
 * the results stream (`results-stream.ts`) and the end-of-run summary (`run-summary.ts`) both build
 * on it, so the two can never disagree about a run.
 *
 * Measured with Playwright 1.63 and playwright-bdd 9.2:
 *
 * - A Gherkin step is a `test.step` titled with its keyword (`When the backup runs`); a Background's
 *   steps sit inside the `Before Hooks › Background` hook step.
 * - A failing hook's error sits on `Before Hooks › BeforeEach Hooks › <the hook>` (or `After …`); a
 *   failing fixture's on `Before Hooks › Fixture "<name>"`; a hook that times out on
 *   `BeforeEach Hooks`, its hook step carrying none.
 * - A timeout inside a step, and a crashed worker, leave **no** step with an error.
 * - A skip (`test.skip()`, the drain) puts `Test is skipped: …` on a step while the result reads
 *   `skipped` with no error — so a status is read from the result, never from step errors.
 */

/** The final status of a test: Playwright's outcome, with an interrupted last attempt said as such. */
export type TestStatus =
  "passed" | "failed" | "flaky" | "skipped" | "interrupted";

/** How a run's tests ended, by {@link TestStatus}, plus those that never got a final result. */
export interface Counts {
  /** Every test the run planned. */
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly flaky: number;
  readonly skipped: number;
  readonly interrupted: number;
  /** Planned but never finished: a failed setup's cell, or a run stopped before reaching them. */
  readonly didNotRun: number;
}

/** Where a failure's first error was found. */
export type ErrorPlace =
  /** A failing step (a Gherkin step, or a setup's `test.step`) carries it. */
  | "step"
  /** A hook or a fixture carries it. */
  | "hook"
  /** No step carries it — a timeout inside a step, a crashed worker: `step` is the last one begun. */
  | "last-step"
  /** The test began no step at all. */
  | "test";

/** The first error a test that did not pass shows, and where. */
export interface FirstError {
  /** The message, without ANSI codes, at most {@link MESSAGE_LIMIT} characters. */
  readonly message: string;
  readonly where: ErrorPlace;
  /**
   * The step, as titles joined by ` › ` from the outermost step reported down: a Gherkin step's own
   * title, or a hook's path (`After Hooks › AfterEach Hooks › my hook`). Absent for `test`.
   */
  readonly step?: string;
}

/** Where a scenario sits: its feature, the Rule/Outline titles between, its own title, its file. */
export interface ScenarioPlace {
  /** The Feature's title; for a setup, its file name. */
  readonly feature: string;
  /** The scenario's title, an Outline's example row included. */
  readonly scenario: string;
  /** The Rule and Scenario Outline titles between the Feature and the scenario, outermost first. */
  readonly path: readonly string[];
  /** The `.feature` file, relative to the repository, when the test was generated from one. */
  readonly file?: string;
}

/** The longest message a stream line carries, so one runaway error cannot bloat it. */
export const MESSAGE_LIMIT = 2_000;

/** What closes a message cut at {@link MESSAGE_LIMIT}. */
const TRUNCATED = "… [truncated]";

/** A Gherkin step's title starts with its keyword — `*` included — and a space. */
const GHERKIN_STEP = /^(?:Given|When|Then|And|But|\*) /;

/**
 * The step categories whose titles may be reported. Titles of the others can hold values a test
 * typed — Playwright titles a `fill()` with its text — so the stream never names them.
 */
const REPORTABLE_CATEGORIES: ReadonlySet<string> = new Set([
  "test.step",
  "hook",
  "fixture",
]);

/** Joins step titles the way Playwright's own reporters do. */
const PATH_SEPARATOR = " › ";

/**
 * Whether Playwright will run this attempt's test again — the rule its dispatcher applies
 * (`runner/index.js`, `JobDispatcher._onDone`), not the one its own reporters guess with:
 *
 * - an attempt that ended as its test expected, or was skipped by the test itself (`test.skip()`,
 *   the drain), is not retried;
 * - one that failed is, and so is one Playwright skipped without running it (a `beforeAll` that
 *   failed, a crashed worker), while retries remain;
 * - an interrupted one never is.
 *
 * It still cannot know two cases: a failure Playwright judges not worth retrying (a screenshot with
 * no baseline yet), and a retry the run stops before reaching. {@link RunTally.settle} ends those at
 * the run's end. `test.expectedStatus` and `test.results` already reflect this attempt in `onTestEnd`.
 *
 * @param test - the test, as `onTestEnd` sees it.
 * @param result - the attempt that just ended.
 */
export function willRetry(
  test: Pick<TestCase, "results" | "retries" | "expectedStatus">,
  result: Pick<TestResult, "status">,
): boolean {
  if (result.status === "interrupted") return false;
  if (test.results.length > test.retries) return false;
  if (result.status === "skipped") return test.expectedStatus !== "skipped";
  return result.status !== test.expectedStatus;
}

/**
 * A test's final status, read after its last attempt. An interrupted attempt reads as `skipped` in
 * Playwright's outcome, so it is checked first.
 *
 * @param test - the test.
 * @param last - its last attempt.
 */
export function finalStatus(
  test: Pick<TestCase, "outcome">,
  last: Pick<TestResult, "status">,
): TestStatus {
  if (last.status === "interrupted") return "interrupted";
  switch (test.outcome()) {
    case "expected":
      return "passed";
    case "unexpected":
      return "failed";
    case "flaky":
      return "flaky";
    case "skipped":
      return "skipped";
  }
}

/**
 * Where Playwright's call log starts in an error message. The log follows the error itself, to the
 * end of the message, and quotes the elements it touched as markup — attribute values included
 * (`locator resolved to <input value="…"/>`), which can be anything a page holds: BackWPup's restore
 * wizard renders the site's database password into one.
 */
const CALL_LOG = /\n\s*Call log:\n/;

/**
 * Cuts a string to at most `limit` UTF-16 units without splitting a surrogate pair, which would
 * leave half a character behind.
 */
function cutAt(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const end = Math.max(0, limit);
  const last = text.charCodeAt(end - 1);
  // A high surrogate at the cut opens a pair the cut would split: leave it out too.
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? end - 1 : end);
}

/**
 * A message as a stream line carries it: no ANSI codes, no call log (see {@link CALL_LOG} — the
 * reports keep it whole), no trailing whitespace, at most `limit` characters — a cut one ending with a
 * marker that says so.
 *
 * @param message - the raw message.
 * @param limit - the longest result, the cut marker included.
 */
export function cleanMessage(
  message: string,
  limit: number = MESSAGE_LIMIT,
): string {
  const plain = stripVTControlCharacters(message);
  const callLog = CALL_LOG.exec(plain);
  const head = (
    callLog === null ? plain : plain.slice(0, callLog.index)
  ).trimEnd();
  if (head.length <= limit) return head;
  // Never longer than `limit`, even when the marker itself does not fit.
  if (limit <= TRUNCATED.length) return cutAt(TRUNCATED, limit);
  return `${cutAt(head, limit - TRUNCATED.length)}${TRUNCATED}`;
}

/** The step shape the attribution reads: a subset of Playwright's `TestStep`, so a spec can build one. */
export interface StepLike {
  readonly title: string;
  readonly category: string;
  readonly error?: { readonly message?: string; readonly value?: string };
  readonly steps: readonly StepLike[];
}

/** A step and the steps above it, outermost first. */
type StepChain = readonly StepLike[];

/** Every step under `steps`, depth first, each with the chain that leads to it. */
function* walk(
  steps: readonly StepLike[],
  above: StepChain = [],
): Generator<StepChain> {
  for (const step of steps) {
    const chain = [...above, step];
    yield chain;
    yield* walk(step.steps, chain);
  }
}

/** Whether a step is a Gherkin step. */
function isGherkinStep(step: StepLike): boolean {
  return step.category === "test.step" && GHERKIN_STEP.test(step.title);
}

/** A chain's titles joined, cut at the first step whose title must not be reported. */
function describeChain(chain: StepChain): string {
  const titles: string[] = [];
  for (const step of chain) {
    if (!REPORTABLE_CATEGORIES.has(step.category)) break;
    titles.push(step.title);
  }
  return titles.join(PATH_SEPARATOR);
}

/** From a failing step, follows its first failing child down to the innermost failing step. */
function innermostFailing(chain: StepChain): StepChain {
  const last = chain.at(-1);
  const child = last?.steps.find((step) => step.error !== undefined);
  return child === undefined ? chain : innermostFailing([...chain, child]);
}

/** A step error's message, or `undefined` when it carries none. */
function stepMessage(step: StepLike | undefined): string | undefined {
  return step?.error?.message ?? step?.error?.value;
}

/**
 * The step a failure is blamed on, in order: the first failing Gherkin step (a Background's
 * included); else the innermost failing step under the first failing step — a hook, a fixture, or
 * a setup's own `test.step`; else, when no step failed (a timeout inside a step, a crash), the last
 * step begun outside the closing hooks.
 */
function blamedStep(
  steps: readonly StepLike[],
): { readonly chain: StepChain; readonly where: ErrorPlace } | undefined {
  // The Gherkin step alone names it, a Background's as much as the scenario's own.
  for (const chain of walk(steps)) {
    const last = chain.at(-1);
    if (last?.error !== undefined && isGherkinStep(last)) {
      return { chain: [last], where: "step" };
    }
  }

  const failing = steps.find((candidate) => candidate.error !== undefined);
  if (failing !== undefined) {
    const chain = innermostFailing([failing]);
    const inHook = chain.some(
      (step) => step.category === "hook" || step.category === "fixture",
    );
    return { chain, where: inHook ? "hook" : "step" };
  }

  // Nothing failed: the closing hooks ran after the failure, so the last top-level step that is not
  // a hook was running — else, when only hooks began (a crash in one), the last of them. Its last
  // reportable children narrow it down.
  const begun =
    steps.filter((candidate) => candidate.category !== "hook").at(-1) ??
    steps.at(-1);
  if (begun === undefined) return undefined;
  let chain: StepChain = [begun];
  for (;;) {
    const next = chain.at(-1)?.steps.at(-1);
    if (next === undefined || !REPORTABLE_CATEGORIES.has(next.category)) break;
    chain = [...chain, next];
  }
  return { chain, where: "last-step" };
}

/**
 * The first error a test's attempt shows, and the step it is blamed on (see {@link blamedStep}).
 *
 * @param result - the attempt: its errors and its steps.
 * @returns the error, or `undefined` when the attempt shows none.
 */
export function firstError(result: {
  readonly errors: readonly {
    readonly message?: string;
    readonly value?: string;
  }[];
  readonly steps: readonly StepLike[];
}): FirstError | undefined {
  const first = result.errors[0];
  const resultMessage = first?.message ?? first?.value;
  const blamed = blamedStep(result.steps);
  const message =
    (blamed?.where === "step" || blamed?.where === "hook"
      ? stepMessage(blamed.chain.at(-1))
      : undefined) ?? resultMessage;
  if (message === undefined) return undefined;
  const step = blamed === undefined ? "" : describeChain(blamed.chain);
  return step === ""
    ? { message: cleanMessage(message), where: "test" }
    : { message: cleanMessage(message), where: blamed?.where ?? "test", step };
}

/**
 * Where a test sits, from its title path — `["", project, spec file, Feature, …Rules and Outlines,
 * scenario]` for a scenario, `["", project, file, test]` for a setup — and its file.
 *
 * @param test - the test.
 * @param testDir - its project's `testDir`: a generated spec's path under it is the feature's path
 *   with `.spec.js` added, which is how the `.feature` file is named.
 */
export function scenarioPlace(
  test: Pick<TestCase, "titlePath" | "location">,
  testDir: string | undefined,
): ScenarioPlace {
  const [, , specFile = "", ...titles] = test.titlePath();
  const scenario = titles.at(-1) ?? "";
  const feature = titles.length > 1 ? (titles[0] ?? "") : specFile;
  const path = titles.slice(1, -1);
  const file = featureFile(test.location.file, testDir);
  return file === undefined
    ? { feature, scenario, path }
    : { feature, scenario, path, file };
}

/** The `.feature` file a generated spec came from, relative and `/`-separated; else `undefined`. */
function featureFile(
  specFile: string,
  testDir: string | undefined,
): string | undefined {
  const suffix = ".feature.spec.js";
  if (testDir === undefined || !specFile.endsWith(suffix)) return undefined;
  const inside = relative(testDir, specFile);
  // Outside the folder: up through `..`, or another root altogether (a Windows drive).
  if (isAbsolute(inside) || inside.split(sep)[0] === "..") return undefined;
  return inside.slice(0, -".spec.js".length).split(sep).join("/");
}

/**
 * Whether a scenario was skipped by the drain: it carries the drain's annotation.
 *
 * @param test - the test.
 */
export function wasDrainedTest(test: Pick<TestCase, "annotations">): boolean {
  return test.annotations.some(
    (annotation) => annotation.type === STOPPED_ANNOTATION,
  );
}

/** How an ended attempt leaves its test: to run again, or finished with a final status. */
export type AttemptVerdict =
  | { readonly final: false }
  | { readonly final: true; readonly status: TestStatus };

/** A test whose retry never came, ended by {@link RunTally.settle}. */
export interface SettledTest {
  readonly test: TestCase;
  /** Its last attempt. */
  readonly result: TestResult;
  readonly status: TestStatus;
}

/** The counts of `total` planned tests, from the final statuses of those that finished. */
function countsOf(total: number, statuses: Iterable<TestStatus>): Counts {
  const counts = {
    total,
    passed: 0,
    failed: 0,
    flaky: 0,
    skipped: 0,
    interrupted: 0,
    didNotRun: 0,
  };
  let finished = 0;
  for (const status of statuses) {
    counts[status] += 1;
    finished += 1;
  }
  // A test the plan did not hold cannot happen, but a count must never go negative.
  counts.didNotRun = Math.max(0, total - finished);
  return counts;
}

/**
 * A run's ledger: what it planned, split into setups and scenarios, how each test finally ended, and
 * which tests still await a retry. A setup counts apart, so a run's "Result" speaks of scenarios.
 *
 * A test's final status is the **last** one recorded for it: Playwright re-runs an ended test only
 * in a serial-mode suite (none of the features is one), and then its later end is the true one.
 */
export class RunTally {
  /** How many scenarios and setups the run plans. */
  private planned = { scenarios: 0, setups: 0 };
  /** Each finished test's final status, by id; a setup's carries its kind. */
  private readonly finals = new Map<
    string,
    { readonly setup?: SetupKind; readonly status: TestStatus }
  >();
  /** The tests a retry is due for, by id, with their last attempt. */
  private readonly pending = new Map<
    string,
    { readonly test: TestCase; readonly result: TestResult }
  >();

  /**
   * Starts the ledger from the run's planned tests.
   *
   * @param tests - every test of the run, as `suite.allTests()` lists them.
   */
  begin(tests: readonly Pick<TestCase, "parent">[]): void {
    const setups = tests.filter((test) => setupOf(test) !== undefined).length;
    this.planned = { scenarios: tests.length - setups, setups };
    this.finals.clear();
    this.pending.clear();
  }

  /**
   * Records an ended attempt: a retry is due ({@link willRetry}), or the test is finished.
   *
   * @param test - the test; its `results` already hold this attempt.
   * @param result - the attempt that ended.
   */
  attemptEnded(test: TestCase, result: TestResult): AttemptVerdict {
    if (willRetry(test, result)) {
      this.pending.set(test.id, { test, result });
      return { final: false };
    }
    this.pending.delete(test.id);
    const status = finalStatus(test, result);
    this.finish(test, status);
    return { final: true, status };
  }

  /**
   * Ends every test whose due retry never ran — the run stopped first, or Playwright judged its
   * error not worth retrying — with the status its attempts so far give it. Call once, as the run
   * ends; a test settled here is then counted like any other.
   *
   * @returns the tests settled, in the order their last attempts ended.
   */
  settle(): SettledTest[] {
    const settled = [...this.pending.values()].map(({ test, result }) => {
      const status = finalStatus(test, result);
      this.finish(test, status);
      return { test, result, status };
    });
    this.pending.clear();
    return settled;
  }

  /** The scenarios' counts so far. */
  get scenarios(): Counts {
    return countsOf(
      this.planned.scenarios,
      [...this.finals.values()]
        .filter((f) => f.setup === undefined)
        .map((f) => f.status),
    );
  }

  /** The setups' counts so far. */
  get setups(): Counts {
    return countsOf(
      this.planned.setups,
      [...this.finals.values()]
        .filter((f) => f.setup !== undefined)
        .map((f) => f.status),
    );
  }

  /** Records a test's final status, replacing any earlier one. */
  private finish(test: TestCase, status: TestStatus): void {
    const setup = setupOf(test);
    this.finals.set(
      test.id,
      setup === undefined ? { status } : { setup, status },
    );
  }
}

/**
 * Which setup a test belongs to, from its project's name; `undefined` for a scenario.
 *
 * @param test - the test.
 */
export function setupOf(test: Pick<TestCase, "parent">): SetupKind | undefined {
  const project = test.parent.project()?.name;
  return project === undefined ? undefined : setupKindOf(project);
}
