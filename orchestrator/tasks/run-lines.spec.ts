import { test, expect } from "@playwright/test";

import { finishedEvent } from "../__fixtures__/run-finished";
import type { StopLevel } from "../runs/stop";
import {
  eventTask,
  furtherStop,
  MAX_FAILURE_LENGTH,
  notStartedOutcome,
  outcomeLine,
  showPath,
  startedLine,
  unreadOutcome,
  type CycleTask,
} from "./run-lines";

/** A secret the orchestrator holds, which no line or reason may show. */
const SECRET = "bwp-run-lines-secret-0123456789";

/** The task the lines are about. */
const TASK: CycleTask = {
  id: "bpng",
  product: "backwpup",
  cell: "pro@nginx",
};

/** A stop asked for. */
interface Stop {
  readonly level: StopLevel;
  readonly why: string;
}

/** Paths shown as they are, so a line's parts read plainly. */
const AS_IS = (path: string): string => path;

test.describe("showPath", () => {
  test("shows a path inside the base relative to it, any other as it is", () => {
    expect(showPath("/co/.orchestrator/runs/bpng-1/run.log", "/co")).toBe(
      ".orchestrator/runs/bpng-1/run.log",
    );
    expect(showPath("/elsewhere/run.log", "/co")).toBe("/elsewhere/run.log");
    expect(showPath("/co-other/run.log", "/co")).toBe("/co-other/run.log");
    expect(showPath("/co", "/co")).toBe("/co");
  });
});

test.describe("eventTask", () => {
  test("names the ref and the filter only when the task has them", () => {
    expect(eventTask(TASK)).toEqual({
      id: "bpng",
      product: "backwpup",
      cell: "pro@nginx",
    });
    expect(
      eventTask({
        ...TASK,
        name: "Pro on nginx",
        plugin: { ref: "develop", version: "9.9.9" },
        grep: "@smoke",
      }),
    ).toEqual({
      id: "bpng",
      name: "Pro on nginx",
      product: "backwpup",
      cell: "pro@nginx",
      ref: "develop",
      grep: "@smoke",
    });
    expect(
      eventTask({ ...TASK, plugin: { version: "9.9.9" } }),
    ).not.toHaveProperty("ref");
  });
});

test.describe("startedLine", () => {
  test("says the unit, the ref, the filter and the log", () => {
    expect(
      startedLine(
        "bpng-12",
        { ...TASK, plugin: { ref: "develop" }, grep: "@smoke" },
        ".orchestrator/runs/bpng-12/run.log",
      ),
    ).toBe(
      "bpng-12 started · backwpup pro@nginx · develop · @smoke · .orchestrator/runs/bpng-12/run.log",
    );
  });

  test("says the default ref when the task names none, and no filter when it has none", () => {
    expect(startedLine("bpng-1", TASK, "run.log")).toBe(
      "bpng-1 started · backwpup pro@nginx · default ref · run.log",
    );
  });
});

test.describe("outcomeLine", () => {
  test("gives a run that tested its counts, its time and its report", () => {
    const event = finishedEvent({
      status: "flaky",
      reason: null,
      durationMs: 3_250_000,
      counts: {
        total: 52,
        passed: 51,
        failed: 0,
        flaky: 1,
        skipped: 0,
        didNotRun: 0,
      },
    });
    expect(outcomeLine(event, AS_IS)).toBe(
      `bpng-12 ⚠ flaky · 52 scenarios: 51 passed, 1 flaky · 54m 10s · ${event.report.dir}`,
    );
  });

  test("gives a run that did not test its reason and its log, and no counts when none were planned", () => {
    const event = finishedEvent({
      status: "error",
      reason: "bddgen exited 1",
      durationMs: 3_000,
      counts: {
        total: 0,
        passed: 0,
        failed: 0,
        flaky: 0,
        skipped: 0,
        didNotRun: 0,
      },
    });
    expect(outcomeLine(event, AS_IS)).toBe(
      `bpng-12 ✘ error · bddgen exited 1 · 3s · ${event.report.log}`,
    );
  });

  test("marks each status, and points only a tested run at its report", () => {
    const marks = {
      passed: "✔",
      flaky: "⚠",
      failed: "✘",
      error: "✘",
      stopped: "■",
      killed: "■",
    } as const;
    for (const [status, mark] of Object.entries(marks)) {
      const event = finishedEvent({ status: status as keyof typeof marks });
      const line = outcomeLine(event, (path) => `<${path}>`);
      expect(line.startsWith(`bpng-12 ${mark} ${status} · `)).toBe(true);
      const tested = ["passed", "flaky", "failed"].includes(status);
      expect(
        line.endsWith(`<${tested ? event.report.dir : event.report.log}>`),
      ).toBe(true);
    }
  });

  test("names one scenario in the singular and each count that is not 0", () => {
    const event = finishedEvent({
      status: "failed",
      reason: null,
      durationMs: 0,
      counts: {
        total: 1,
        passed: 0,
        failed: 1,
        flaky: 0,
        skipped: 0,
        didNotRun: 0,
      },
    });
    expect(outcomeLine(event, AS_IS)).toContain(
      " · 1 scenario: 1 failed · 0s · ",
    );
    const all = finishedEvent({
      reason: null,
      counts: {
        total: 9,
        passed: 1,
        failed: 2,
        flaky: 3,
        skipped: 1,
        didNotRun: 2,
      },
    });
    expect(outcomeLine(all, AS_IS)).toContain(
      "9 scenarios: 1 passed, 3 flaky, 2 failed, 1 skipped, 2 did not run",
    );
  });
});

test.describe("furtherStop", () => {
  const drain: Stop = { level: "drained", why: "first" };
  const interrupt: Stop = { level: "interrupted", why: "second" };
  const kill: Stop = { level: "killed", why: "third" };

  test("takes the first stop, then only one that goes further", () => {
    expect(furtherStop(undefined, drain)).toBe(drain);
    expect(furtherStop(drain, interrupt)).toBe(interrupt);
    expect(furtherStop(interrupt, kill)).toBe(kill);
    expect(furtherStop(kill, drain)).toBe(kill);
    expect(furtherStop(interrupt, drain)).toBe(interrupt);
  });

  test("keeps the earlier stop, and its reason, on a tie", () => {
    const again: Stop = { level: "drained", why: "again" };
    expect(furtherStop(drain, again)).toBe(drain);
  });
});

test.describe("unreadOutcome", () => {
  test("reads a killed run as killed and any other stop as stopped, with the stop's reason", () => {
    expect(
      unreadOutcome(
        { level: "killed", why: "third Ctrl-C" },
        new Error("x"),
        [],
      ),
    ).toEqual({ status: "killed", reason: "third Ctrl-C" });
    for (const level of ["drained", "interrupted"] as const)
      expect(
        unreadOutcome({ level, why: "Ctrl-C" }, new Error("x"), []),
      ).toEqual({
        status: "stopped",
        reason: "Ctrl-C",
      });
  });

  test("reads a run nobody stopped as an error, saying why, masked and on one line", () => {
    const outcome = unreadOutcome(
      { level: "none" },
      new Error(`EIO\nreading ${SECRET}`),
      [SECRET],
    );
    expect(outcome.status).toBe("error");
    expect(outcome.reason).toMatch(/^its end could not be read: EIO reading /);
    expect(outcome.reason).not.toContain(SECRET);
  });
});

test.describe("notStartedOutcome", () => {
  test("is an error saying why the run could not start, masked, cut and on one line", () => {
    const outcome = notStartedOutcome(
      new Error(`EEXIST ${SECRET}\n${"x".repeat(1_000)}`),
      [SECRET],
    );
    expect(outcome.status).toBe("error");
    expect(outcome.reason).toMatch(/^the run could not start: EEXIST /);
    expect(outcome.reason).not.toContain(SECRET);
    expect(outcome.reason).not.toContain("\n");
    expect(Array.from(outcome.reason ?? "").length).toBeLessThanOrEqual(
      "the run could not start: ".length + MAX_FAILURE_LENGTH,
    );
  });

  test("says `failed` for a throw with nothing printable", () => {
    expect(notStartedOutcome(undefined, []).reason).toBe(
      "the run could not start: undefined",
    );
    expect(notStartedOutcome("", []).reason).toBe(
      "the run could not start: failed",
    );
  });
});
