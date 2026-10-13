import type {
  ResultsEvent,
  RunBeginEvent,
  RunEndEvent,
  ScenarioEndEvent,
  SetupEndEvent,
} from "../../src/common/reporting/results-schema";

/**
 * Results-stream lines for the orchestrator's specs, shaped as the suite's reporter writes them
 * (a real `pro@nginx` stream was the model): each builder takes only what a test varies.
 */

/** When every line was written: the time is not what these specs judge. */
const AT = "2026-10-13T10:15:31.000Z";

/** Counts with every field 0 but those given. */
export function counts(
  given: Partial<RunEndEvent["scenarios"]> = {},
): RunEndEvent["scenarios"] {
  return {
    total: 0,
    passed: 0,
    failed: 0,
    flaky: 0,
    skipped: 0,
    interrupted: 0,
    didNotRun: 0,
    drained: 0,
    ...given,
  };
}

/** `run.begin` for `scenarios` planned scenarios. */
export function runBegin(scenarios: number): RunBeginEvent {
  return {
    v: 1,
    type: "run.begin",
    at: AT,
    runId: "2026-10-13T10-15-31-042Z-bpng-12",
    product: "backwpup",
    cell: "pro@nginx",
    edition: "pro",
    mode: "test",
    scenarios,
    setups: 2,
    retries: 2,
    workers: 1,
  };
}

/** A setup's end. */
export function setupEnd(
  setup: "auth" | "artifacts",
  status: SetupEndEvent["status"],
  message?: string,
): SetupEndEvent {
  return {
    v: 1,
    type: "setup.end",
    at: AT,
    id: `setup-${setup}`,
    project: `${setup === "auth" ? "setup" : "artifacts"}:pro@nginx`,
    setup,
    status,
    attempts: 1,
    durationMs: 1000,
    ...(message === undefined
      ? {}
      : { error: { message, where: "step" as const } }),
  };
}

/** A scenario's end, `id` naming it. */
export function scenarioEnd(
  id: string,
  status: ScenarioEndEvent["status"],
  extra: Partial<ScenarioEndEvent> = {},
): ScenarioEndEvent {
  return {
    v: 1,
    type: "scenario.end",
    at: AT,
    id,
    project: "pro@nginx",
    feature: "Backups",
    scenario: `Scenario ${id}`,
    path: [],
    tags: [],
    status,
    outcome: status === "passed" ? "expected" : "unexpected",
    attempts: 1,
    durationMs: 100,
    ...extra,
  };
}

/** `run.end` with the scenarios' counts given. */
export function runEnd(
  status: RunEndEvent["status"],
  scenarios: Partial<RunEndEvent["scenarios"]> = {},
  setups: Partial<RunEndEvent["setups"]> = { total: 2, passed: 2 },
): RunEndEvent {
  return {
    v: 1,
    type: "run.end",
    at: AT,
    status,
    durationMs: 60_000,
    scenarios: counts(scenarios),
    setups: counts(setups),
  };
}

/** `run.error`. */
export function runError(message: string): ResultsEvent {
  return { v: 1, type: "run.error", at: AT, message };
}

/** A stream's text: one JSON line per event. */
export function streamOf(events: readonly ResultsEvent[]): string {
  return events.map((event) => `${JSON.stringify(event)}\n`).join("");
}
