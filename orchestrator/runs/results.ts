import { z } from "zod";

import { parseResults } from "../../src/common/reporting/results-reader";
import type {
  RunEndEvent,
  ScenarioEndEvent,
} from "../../src/common/reporting/results-schema";

/**
 * A finished run's results stream (`results.jsonl`), read once the run has ended: what began, what
 * ended and how, kept as the stream's schema promises — the last `scenario.end` and `setup.end` per
 * test id, lines this reader does not know skipped.
 *
 * The suite's reader trusts a known line's fields as written; this one checks every field it uses,
 * because the outcome and the event are built from them: a line of the wrong shape is dropped, and a
 * count of the wrong type reads as 0 — never a crash, never a value of another type in the event.
 */

/** A test's final status, as the stream writes it. */
export const TEST_STATUSES = [
  "passed",
  "failed",
  "flaky",
  "skipped",
  "interrupted",
] as const satisfies readonly ScenarioEndEvent["status"][];

/** A final status. */
export type TestStatus = (typeof TEST_STATUSES)[number];

/** Playwright's status for a whole run, as `run.end` writes it. */
const RUN_STATUSES = [
  "passed",
  "failed",
  "timedout",
  "interrupted",
] as const satisfies readonly RunEndEvent["status"][];

/** The longest Rule/Outline path kept: Gherkin nests a Rule and an Outline at most. */
const MAX_PATH = 8;

/** A count: a whole number from 0; anything else reads as 0. */
const count = z.number().int().nonnegative().catch(0);

/** A duration in milliseconds: a number from 0 (zod refuses infinities); anything else reads as 0. */
const duration = z.number().nonnegative().catch(0);

/** How a run's tests ended, by status; `drained` 0 in a stream written before it existed. */
const countsSchema = z.object({
  total: count,
  passed: count,
  failed: count,
  flaky: count,
  skipped: count,
  interrupted: count,
  didNotRun: count,
  drained: count,
});

/** The scenarios' counts. */
export type ScenarioCounts = z.output<typeof countsSchema>;

/** A test's first error: its message, when it is text. */
const errorSchema = z
  .object({ message: z.string() })
  .optional()
  .catch(undefined);

/** `run.begin`: the edition and how many scenarios the run planned. */
const beginSchema = z.object({
  edition: z.string().optional().catch(undefined),
  scenarios: count,
});

/** `run.end`: Playwright's status and the counts. A missing counts object reads as all 0. */
const endSchema = z.object({
  status: z.enum(RUN_STATUSES),
  scenarios: countsSchema.catch(() => countsSchema.parse({})),
  setups: countsSchema.catch(() => countsSchema.parse({})),
});

/** `setup.end`. */
const setupSchema = z.object({
  id: z.string(),
  setup: z.string(),
  status: z.enum(TEST_STATUSES),
  error: errorSchema,
});

/** `scenario.end`. */
const scenarioSchema = z.object({
  id: z.string(),
  feature: z.string(),
  scenario: z.string(),
  path: z
    .array(z.string())
    .catch([])
    .transform((path) => path.slice(0, MAX_PATH)),
  status: z.enum(TEST_STATUSES),
  attempts: count,
  durationMs: duration,
  drained: z.literal(true).optional().catch(undefined),
  error: errorSchema,
});

/** `run.error`. */
const runErrorSchema = z.object({ message: z.string() });

/** How a run began. */
export type RunBegin = z.output<typeof beginSchema>;

/** How a run ended, as Playwright saw it. */
export type RunEnd = z.output<typeof endSchema>;

/** A setup, as it finally ended. */
export type SetupResult = z.output<typeof setupSchema>;

/** A scenario, as it finally ended. */
export type ScenarioResult = z.output<typeof scenarioSchema>;

/** What a run's results stream held. */
export interface RunResults {
  /** `run.begin`; absent when the runner never got that far. */
  readonly begin?: RunBegin;
  /** `run.end`; absent when the runner died — or was killed — before it. */
  readonly end?: RunEnd;
  /** Each setup's last `setup.end`, in the order they first ended. */
  readonly setups: readonly SetupResult[];
  /** Each scenario's last `scenario.end`, in the order they first ended. */
  readonly scenarios: readonly ScenarioResult[];
  /** Every `run.error`'s message: an error outside any test. */
  readonly runErrors: readonly string[];
}

/**
 * Reads a finished run's stream. A last line without its newline is read too: the runner may have
 * died writing it, and an unfinished line is skipped like any other that is not an event.
 *
 * @param text - the stream's whole text.
 * @returns what it held.
 */
export function readRunResults(text: string): RunResults {
  const { events } = parseResults(text.endsWith("\n") ? text : `${text}\n`);
  let begin: RunBegin | undefined;
  let end: RunEnd | undefined;
  const setups = new Map<string, SetupResult>();
  const scenarios = new Map<string, ScenarioResult>();
  const runErrors: string[] = [];
  for (const event of events) {
    switch (event.type) {
      case "run.begin":
        begin ??= parsed(beginSchema, event);
        break;
      case "run.end":
        end = parsed(endSchema, event) ?? end;
        break;
      case "setup.end":
        keep(setups, parsed(setupSchema, event));
        break;
      case "scenario.end":
        keep(scenarios, parsed(scenarioSchema, event));
        break;
      case "run.error": {
        const error = parsed(runErrorSchema, event);
        if (error !== undefined) runErrors.push(error.message);
        break;
      }
      default:
        break;
    }
  }
  return {
    ...(begin === undefined ? {} : { begin }),
    ...(end === undefined ? {} : { end }),
    setups: [...setups.values()],
    scenarios: [...scenarios.values()],
    runErrors,
  };
}

/**
 * A line as `schema` reads it, or `undefined` when it is not of that shape.
 *
 * @param schema - the line's schema.
 * @param line - the line, as the suite's reader parsed it.
 */
function parsed<T extends z.ZodType>(
  schema: T,
  line: unknown,
): z.output<T> | undefined {
  const result = schema.safeParse(line);
  return result.success ? result.data : undefined;
}

/**
 * Keeps a test's last end, in the place it first ended: a Map keeps a key's place when its value is
 * replaced.
 *
 * @param ends - the ends so far, by test id.
 * @param end - this line's, when it was of the right shape.
 */
function keep<T extends { readonly id: string }>(
  ends: Map<string, T>,
  end: T | undefined,
): void {
  if (end !== undefined) ends.set(end.id, end);
}

/**
 * The scenarios' counts: `run.end`'s when the run reached it, else counted from the scenarios that
 * ended, every planned one that did not counted as not run.
 *
 * @param results - the run's results.
 * @returns the counts.
 */
export function scenarioCounts(results: RunResults): ScenarioCounts {
  if (results.end !== undefined) return results.end.scenarios;
  const counts = countsSchema.parse({});
  for (const scenario of results.scenarios) {
    counts[scenario.status] += 1;
    if (scenario.drained === true) counts.drained += 1;
  }
  const ended = results.scenarios.length;
  counts.total = Math.max(results.begin?.scenarios ?? 0, ended);
  counts.didNotRun = counts.total - ended;
  return counts;
}
