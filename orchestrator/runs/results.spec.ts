import { test, expect } from "@playwright/test";

import type { ScenarioEndEvent } from "../../src/common/reporting/results-schema";
import {
  counts,
  runBegin,
  runEnd,
  runError,
  scenarioEnd,
  setupEnd,
  streamOf,
} from "../__fixtures__/results";
import {
  MAX_LINE_LENGTH,
  readRunResults,
  scenarioCounts,
  TEST_STATUSES,
  type TestStatus,
} from "./results";

/** One stream line, as JSON text, from any object — a line the suite would never write included. */
function line(event: object): string {
  return `${JSON.stringify({ v: 1, at: "2026-10-13T10:15:31.000Z", ...event })}\n`;
}

test.describe("readRunResults", () => {
  test("keeps the begin, the end, the setups, the scenarios and the errors outside any test", () => {
    const results = readRunResults(
      streamOf([
        runBegin(2),
        setupEnd("auth", "passed"),
        scenarioEnd("a", "passed"),
        runError("worker teardown failed"),
        scenarioEnd("b", "failed", {
          path: ["Rule: r"],
          error: { message: "boom", where: "step" },
        }),
        runEnd("failed", { total: 2, passed: 1, failed: 1 }),
      ]),
    );
    expect(results).toEqual({
      begin: { edition: "pro", scenarios: 2 },
      end: {
        status: "failed",
        scenarios: counts({ total: 2, passed: 1, failed: 1 }),
        setups: counts({ total: 2, passed: 2 }),
      },
      setups: [{ id: "setup-auth", setup: "auth", status: "passed" }],
      scenarios: [
        {
          id: "a",
          feature: "Backups",
          scenario: "Scenario a",
          path: [],
          status: "passed",
          attempts: 1,
          durationMs: 100,
        },
        {
          id: "b",
          feature: "Backups",
          scenario: "Scenario b",
          path: ["Rule: r"],
          status: "failed",
          attempts: 1,
          durationMs: 100,
          error: { message: "boom" },
        },
      ],
      runErrors: ["worker teardown failed"],
    });
  });

  test("keeps each test's last end, in the place it first ended", () => {
    const results = readRunResults(
      streamOf([
        scenarioEnd("a", "failed"),
        scenarioEnd("b", "passed"),
        scenarioEnd("a", "passed", { attempts: 3 }),
        setupEnd("auth", "failed"),
        setupEnd("auth", "passed"),
      ]),
    );
    expect(results.scenarios.map((s) => [s.id, s.status, s.attempts])).toEqual([
      ["a", "passed", 3],
      ["b", "passed", 1],
    ]);
    expect(results.setups.map((s) => s.status)).toEqual(["passed"]);
  });

  test("keeps the first run.begin should a stream hold two", () => {
    const results = readRunResults(streamOf([runBegin(1), runBegin(9)]));
    expect(results.begin?.scenarios).toBe(1);
  });

  test("reads a last line without its newline, and skips one the runner died writing", () => {
    const end = JSON.stringify(runEnd("passed"));
    expect(readRunResults(end).end?.status).toBe("passed");
    const cutShort = streamOf([runBegin(1)]) + end.slice(0, 20);
    expect(readRunResults(cutShort).end).toBeUndefined();
  });

  test("skips what is not an event of version 1, and reads an empty stream as nothing", () => {
    const text = `not json\n{"v":2,"type":"run.end","at":"x"}\n{"v":1,"type":"run.later","at":"x"}\n`;
    const nothing = { setups: [], scenarios: [], runErrors: [] };
    expect(readRunResults(text)).toEqual(nothing);
    expect(readRunResults("")).toEqual(nothing);
  });
});

test.describe("readRunResults — lines of the wrong shape", () => {
  test("drops a scenario or setup whose identity or status is not what the suite writes", () => {
    const text = [
      { ...scenarioEnd("a", "passed"), status: "total" },
      { ...scenarioEnd("b", "passed"), status: "constructor" },
      { ...scenarioEnd("c", "passed"), feature: 42 },
      { ...scenarioEnd("d", "passed"), id: null },
      { ...setupEnd("auth", "failed"), status: "broken" },
    ]
      .map(line)
      .join("");
    const results = readRunResults(text);
    expect(results.scenarios).toEqual([]);
    expect(results.setups).toEqual([]);
    expect(scenarioCounts(results)).toEqual(counts());
  });

  test("reads a wrongly typed field as unknown: a path not of text, a count not a whole number, an error not of text", () => {
    const text = line({
      ...scenarioEnd("a", "failed"),
      path: "notarray",
      attempts: "x",
      durationMs: -5,
      drained: "yes",
      error: { message: {} },
    });
    expect(readRunResults(text).scenarios).toEqual([
      {
        id: "a",
        feature: "Backups",
        scenario: "Scenario a",
        path: [],
        status: "failed",
        attempts: 0,
        durationMs: 0,
      },
    ]);
  });

  test("reads a run.end whose counts are missing or wrongly typed as 0s, and drops one with an unknown status", () => {
    const missing = readRunResults(
      line({ type: "run.end", status: "passed", scenarios: null }),
    );
    expect(missing.end).toEqual({
      status: "passed",
      scenarios: counts(),
      setups: counts(),
    });
    const odd = readRunResults(
      line({
        type: "run.end",
        status: "passed",
        scenarios: { total: "3", passed: 1.5, failed: -1, flaky: 1 },
      }),
    );
    expect(odd.end?.scenarios).toEqual(counts({ flaky: 1 }));
    expect(
      readRunResults(line({ ...runEnd("passed"), status: "weird" })).end,
    ).toBeUndefined();
  });

  test("keeps the last well-formed run.end when a later one is malformed", () => {
    const text =
      streamOf([runEnd("failed", { total: 1, failed: 1 })]) +
      line({ type: "run.end", status: 7 });
    expect(readRunResults(text).end?.status).toBe("failed");
  });

  test("survives a deeply nested path and caps a long one", () => {
    // Written as text: building it with JSON.stringify would itself overflow the stack.
    const depth = 100_000;
    const nested = `${"[".repeat(depth)}"x"${"]".repeat(depth)}`;
    const deepLine = line({ ...scenarioEnd("a", "passed"), path: [] }).replace(
      '"path":[]',
      `"path":[${nested}]`,
    );
    const deep = readRunResults(deepLine);
    expect(deep.scenarios[0]?.path).toEqual([]);
    expect(() => JSON.stringify(deep)).not.toThrow();
    const long = readRunResults(
      line({
        ...scenarioEnd("b", "passed"),
        path: Array.from({ length: 50 }, (_, i) => `R${String(i)}`),
      }),
    );
    expect(long.scenarios[0]?.path).toHaveLength(8);
  });

  test("drops a run.error whose message is not text", () => {
    expect(
      readRunResults(line({ type: "run.error", message: { a: 1 } })).runErrors,
    ).toEqual([]);
  });
});

test.describe("scenarioCounts", () => {
  test("takes run.end's counts when the run reached it", () => {
    const results = readRunResults(
      streamOf([runEnd("failed", { total: 5, passed: 3, failed: 2 })]),
    );
    expect(scenarioCounts(results)).toEqual(
      counts({ total: 5, passed: 3, failed: 2 }),
    );
  });

  test("reads a run.end written before drained existed as 0 drained", () => {
    const end = runEnd("passed", { total: 1, passed: 1 });
    const { drained: _, ...older } = end.scenarios;
    const text = `${JSON.stringify({ ...end, scenarios: older })}\n`;
    expect(scenarioCounts(readRunResults(text)).drained).toBe(0);
  });

  test("counts the scenarios that ended when the run never reached run.end, the rest as not run", () => {
    const results = readRunResults(
      streamOf([
        runBegin(5),
        scenarioEnd("a", "passed"),
        scenarioEnd("b", "failed"),
        scenarioEnd("c", "skipped", { drained: true }),
      ]),
    );
    expect(scenarioCounts(results)).toEqual(
      counts({
        total: 5,
        passed: 1,
        failed: 1,
        skipped: 1,
        drained: 1,
        didNotRun: 2,
      }),
    );
  });

  test("never counts fewer planned than ended, nor a negative not-run, without run.begin", () => {
    const results = readRunResults(streamOf([scenarioEnd("a", "flaky")]));
    expect(scenarioCounts(results)).toEqual(counts({ total: 1, flaky: 1 }));
  });
});

test.describe("TEST_STATUSES", () => {
  test("is every status the stream writes, and nothing else", () => {
    // Compile-time: each side is assignable to the other.
    const fromStream: readonly ScenarioEndEvent["status"][] = TEST_STATUSES;
    const toStream = (status: ScenarioEndEvent["status"]): TestStatus => status;
    expect(fromStream).toEqual(
      expect.arrayContaining(["passed", "failed", "flaky", "skipped"]),
    );
    expect(toStream("interrupted")).toBe("interrupted");
    expect(new Set(TEST_STATUSES).size).toBe(TEST_STATUSES.length);
  });
});

test.describe("readRunResults — line cap", () => {
  test("skips a line over the cap unparsed, and reads the rest", () => {
    const long = line({
      type: "run.error",
      message: "x".repeat(MAX_LINE_LENGTH),
    });
    const results = readRunResults(
      streamOf([runBegin(1), scenarioEnd("a", "passed")]) +
        long +
        streamOf([runEnd("passed", { total: 1, passed: 1 })]),
    );
    expect(results.runErrors).toEqual([]);
    expect(results.scenarios).toHaveLength(1);
    expect(results.end?.status).toBe("passed");
    // Just under the cap, the same line is read.
    const fits = line({
      type: "run.error",
      message: "x".repeat(MAX_LINE_LENGTH - 100),
    });
    expect(readRunResults(fits).runErrors).toHaveLength(1);
  });

  test("parses a deeply nested line at the cap without a crash", () => {
    const half = MAX_LINE_LENGTH / 2;
    expect(readRunResults(`${"[".repeat(half)}${"]".repeat(half)}\n`)).toEqual({
      setups: [],
      scenarios: [],
      runErrors: [],
    });
  });
});
