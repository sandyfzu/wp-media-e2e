import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { finishedEvent } from "../__fixtures__/run-finished";
import {
  DAY_MS,
  DEFAULT_RETENTION,
  LEFTOVER_GRACE_MS,
} from "../../src/common/reporting/retention";
import { formatRunId } from "../../src/common/config/run-id";
import { endedRecord, runningRecord, type RunRecord } from "../runs/record";
import {
  MAX_RECORD_BYTES,
  describeRunRetention,
  pruneTaskRuns,
  recordDating,
  runNumberOf,
  runRetentionPolicy,
  type RunRetentionInput,
  type RunRetentionReport,
} from "./run-retention";

/**
 * Run-folder retention on real temporary state directories: which of a task's folders go, which stay
 * and why — the cap, the age rules, the protected runs, undated folders, other tasks, links, FIFOs
 * and a removal's leftovers.
 */

/** The fixed time every case measures against. */
const NOW = Date.parse("2026-10-13T12:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;
/** The task pruned, and another one sharing `runs/`. */
const TASK = "kxqm";
const OTHER = "kxqn";

/** A fresh state directory per test, removed after it. */
let stateDir: string;
let runsDir: string;
test.beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "e2e-run-retention-"));
  runsDir = join(stateDir, "runs");
  mkdirSync(runsDir);
});
test.afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

/** A run's record, started `ageMs` before {@link NOW}. */
function record(
  id: string,
  ageMs: number,
  state: RunRecord["state"],
  taskId = TASK,
): RunRecord {
  const startedAt = new Date(NOW - ageMs);
  const identity = { id, runId: formatRunId(startedAt, id), startedAt };
  return state === "running"
    ? runningRecord(identity, taskId, { name: "playwright", pgid: 4242 })
    : endedRecord(
        identity,
        taskId,
        { bddgen: { code: 0, signal: null }, stop: { level: "none" } },
        finishedEvent(),
      );
}

/**
 * Makes `runs/<id>/` with a log, and its `run.json` — a record, raw text, or none.
 *
 * @returns the folder.
 */
function makeRun(id: string, content?: RunRecord | string): string {
  const dir = join(runsDir, id);
  mkdirSync(dir);
  writeFileSync(join(dir, "run.log"), "a run's output\n");
  if (content !== undefined)
    writeFileSync(
      join(dir, "run.json"),
      typeof content === "string" ? content : JSON.stringify(content),
    );
  return dir;
}

/** A dated run of the task: `<TASK>-<n>`, started `ageMs` ago. */
function dated(
  n: number,
  ageMs: number,
  state: RunRecord["state"] = "ended",
): string {
  const id = `${TASK}-${String(n)}`;
  return makeRun(id, record(id, ageMs, state));
}

/** Prunes the task, at {@link NOW}. */
function prune(
  given: Partial<RunRetentionInput> = {},
): Promise<RunRetentionReport> {
  return pruneTaskRuns({ stateDir, taskId: TASK, now: NOW, ...given });
}

/** What is left in `runs/`, sorted. */
function left(): string[] {
  return readdirSync(runsDir).sort();
}

/** Each planned folder's name and why it is kept or removed. */
function reasons(report: RunRetentionReport): Record<string, string> {
  return Object.fromEntries(
    report.plan.map((decision) => [
      decision.entry.name,
      `${decision.action}:${decision.reason}`,
    ]),
  );
}

test.describe("runRetentionPolicy", () => {
  test("maps the cap as the suite maps E2E_REPORTS_KEEP: absent is the default, 0 lifts only the cap", () => {
    expect(runRetentionPolicy()).toEqual(DEFAULT_RETENTION);
    expect(runRetentionPolicy(0)).toEqual({ ...DEFAULT_RETENTION, keep: 0 });
    expect(runRetentionPolicy(5)).toEqual({ ...DEFAULT_RETENTION, keep: 5 });
    for (const bad of [-1, 1.5, 10_001, Number.NaN])
      expect(() => runRetentionPolicy(bad)).toThrow(RangeError);
  });
});

test.describe("runNumberOf", () => {
  test("reads only names that are exactly the task's run ids", () => {
    expect(runNumberOf(`${TASK}-1`, TASK)).toBe(1);
    expect(runNumberOf(`${TASK}-9007199254740991`, TASK)).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    for (const name of [
      `${TASK}-0`,
      `${TASK}-012`,
      `${TASK}-`,
      `${TASK}-1.5`,
      `${TASK}-1e3`,
      `${TASK}-+1`,
      `${TASK}- 1`,
      `${TASK}-1 `,
      `${TASK}-0x1`,
      `${TASK}--1`,
      `${TASK}-9007199254740993`,
      `${TASK}x-1`,
      `${TASK}1`,
      `${OTHER}-1`,
      `x${TASK}-1`,
      `.pruning-1-1-abcdef01`,
    ])
      expect(runNumberOf(name, TASK), name).toBeUndefined();
  });
});

test.describe("recordDating", () => {
  const name = `${TASK}-3`;
  test("dates a folder by its own record, complete once it ended", () => {
    const at = NOW - HOUR_MS;
    expect(
      recordDating(
        { kind: "text", text: JSON.stringify(record(name, HOUR_MS, "ended")) },
        name,
        TASK,
      ),
    ).toEqual({ time: at, complete: true, record: "ended" });
    expect(
      recordDating(
        {
          kind: "text",
          text: JSON.stringify(record(name, HOUR_MS, "running")),
        },
        name,
        TASK,
      ),
    ).toEqual({ time: at, complete: false, record: "running" });
  });

  test("leaves undated what no record of this folder and task dates", () => {
    const ended = record(name, HOUR_MS, "ended");
    const cases = [
      { kind: "missing" },
      { kind: "tooLarge", bytes: MAX_RECORD_BYTES + 1 },
      { kind: "unreadable", code: "ELOOP" },
      { kind: "text", text: "{not json" },
      { kind: "text", text: JSON.stringify(record(`${TASK}-4`, 0, "ended")) },
      {
        kind: "text",
        text: JSON.stringify(record(name, 0, "ended", OTHER)),
      },
      // Not as the orchestrator writes it: no zone, so `Date.parse` would read it as local time.
      {
        kind: "text",
        text: JSON.stringify({ ...ended, startedAt: "2026-10-13T11:00:00" }),
      },
    ] as const;
    for (const read of cases) {
      const dating = recordDating(read, name, TASK);
      expect(dating.time, JSON.stringify(read)).toBeNaN();
      expect(dating.complete).toBe(false);
      expect(dating.record).toBe("unread");
      expect(dating.undated).toEqual(expect.any(String));
    }
  });
});

test.describe("pruneTaskRuns", () => {
  test("keeps the newest runs up to the cap, removing the oldest and nothing else", async () => {
    for (let n = 1; n <= 23; n++) dated(n, (24 - n) * HOUR_MS);
    const report = await prune();
    expect(report.failed).toEqual([]);
    expect(report.removed.map((r) => r.decision.entry.name).sort()).toEqual([
      `${TASK}-1`,
      `${TASK}-2`,
      `${TASK}-3`,
    ]);
    expect(
      report.removed.every((r) => r.decision.reason === "beyond-cap"),
    ).toBe(true);
    expect(report.removed[0]?.bytes).toBeGreaterThan(0);
    expect(left()).toHaveLength(20);
    expect(left()).not.toContain(`${TASK}-3`);
    // A removal leaves no hidden folder behind.
    expect(left().filter((name) => name.startsWith("."))).toEqual([]);
  });

  test("applies the config's cap; 0 lifts it but not the age rule", async () => {
    for (let n = 1; n <= 4; n++) dated(n, (5 - n) * HOUR_MS);
    dated(5, 31 * DAY_MS);
    expect(reasons(await prune({ keep: 0 }))).toEqual({
      [`${TASK}-4`]: "keep:newest-complete",
      [`${TASK}-3`]: "keep:within-policy",
      [`${TASK}-2`]: "keep:within-policy",
      [`${TASK}-1`]: "keep:within-policy",
      [`${TASK}-5`]: "delete:too-old",
    });
    expect(left()).toHaveLength(4);
    expect(reasons(await prune({ keep: 2 }))).toEqual({
      [`${TASK}-4`]: "keep:newest-complete",
      [`${TASK}-3`]: "keep:within-policy",
      [`${TASK}-2`]: "delete:beyond-cap",
      [`${TASK}-1`]: "delete:beyond-cap",
    });
    expect(left()).toEqual([`${TASK}-3`, `${TASK}-4`]);
  });

  test("keeps the newest complete run past the cap and the age limit, up to 182 days", async () => {
    // The three newest still say `running`: protected, they fill the cap of 2 themselves.
    dated(5, HOUR_MS, "running");
    dated(4, 2 * HOUR_MS, "running");
    dated(3, 3 * HOUR_MS, "running");
    dated(2, 40 * DAY_MS);
    dated(1, 41 * DAY_MS);
    expect(reasons(await prune({ keep: 2 }))).toEqual({
      [`${TASK}-5`]: "keep:protected",
      [`${TASK}-4`]: "keep:protected",
      [`${TASK}-3`]: "keep:protected",
      [`${TASK}-2`]: "keep:newest-complete",
      [`${TASK}-1`]: "delete:too-old",
    });
    expect(left()).toEqual([2, 3, 4, 5].map((n) => `${TASK}-${String(n)}`));
  });

  test("removes even the newest complete run once older than 182 days", async () => {
    dated(1, 183 * DAY_MS);
    expect(reasons(await prune())).toEqual({
      [`${TASK}-1`]: "delete:too-old",
    });
    expect(left()).toEqual([]);
  });

  test("never removes the run in progress, whatever its record says", async () => {
    dated(2, HOUR_MS);
    // Ended already (pruning runs after the end is recorded), and beyond a cap of 1.
    const current = dated(1, 2 * HOUR_MS);
    expect(reasons(await prune({ keep: 1, current }))).toEqual({
      [`${TASK}-2`]: "keep:newest-complete",
      [`${TASK}-1`]: "keep:protected",
    });
    expect(existsSync(current)).toBe(true);
  });

  test("never removes a folder whose record still says running, however old", async () => {
    dated(2, HOUR_MS);
    const lost = dated(1, 40 * DAY_MS, "running");
    expect(reasons(await prune({ keep: 1 }))).toEqual({
      [`${TASK}-2`]: "keep:newest-complete",
      [`${TASK}-1`]: "keep:protected",
    });
    expect(existsSync(lost)).toBe(true);
  });

  test("keeps every folder its record does not date, outside the cap — never dated by mtime", async () => {
    dated(1, HOUR_MS);
    makeRun(`${TASK}-2`);
    makeRun(`${TASK}-3`, "{not json");
    makeRun(
      `${TASK}-4`,
      JSON.stringify(record(`${TASK}-99`, 40 * DAY_MS, "ended")),
    );
    makeRun(
      `${TASK}-5`,
      JSON.stringify(record(`${TASK}-5`, 40 * DAY_MS, "ended", OTHER)),
    );
    // Oversized: read as absent, never parsed.
    makeRun(`${TASK}-6`, " ".repeat(MAX_RECORD_BYTES + 1));
    // A FIFO in its place: refused without waiting for a writer.
    execFileSync("mkfifo", [join(makeRun(`${TASK}-7`), "run.json")]);
    // A link in its place, to a record that would date it as old: refused, never followed.
    const outside = join(stateDir, "elsewhere.json");
    writeFileSync(
      outside,
      JSON.stringify(record(`${TASK}-8`, 40 * DAY_MS, "ended")),
    );
    symlinkSync(outside, join(makeRun(`${TASK}-8`), "run.json"));
    const report = await prune({ keep: 1 });
    expect(report.failed).toEqual([]);
    const plan = Object.fromEntries(report.plan.map((d) => [d.entry.name, d]));
    expect(plan[`${TASK}-1`]?.reason).toBe("newest-complete");
    for (let n = 2; n <= 8; n++) {
      const decision = plan[`${TASK}-${String(n)}`];
      expect(decision?.reason, `${TASK}-${String(n)}`).toBe("undated");
      expect(decision?.rank).toBeUndefined();
    }
    expect(plan[`${TASK}-6`]?.entry.undated).toMatch(/over the cap/);
    expect(plan[`${TASK}-7`]?.entry.undated).toMatch(/not a file/);
    expect(plan[`${TASK}-8`]?.entry.undated).toMatch(/ELOOP/);
    expect(left()).toHaveLength(8);
  });

  test("leaves another task's folders, and names that are not the task's runs, alone", async () => {
    dated(1, HOUR_MS);
    for (let n = 1; n <= 3; n++) {
      const id = `${OTHER}-${String(n)}`;
      makeRun(id, record(id, 40 * DAY_MS, "ended", OTHER));
    }
    // Named like the task's runs, but not one: a longer task id sharing its prefix, a padded number.
    for (const id of [`${TASK}z-1`, `${TASK}-01`, `${TASK}-0`])
      makeRun(id, JSON.stringify({ ...record(id, 40 * DAY_MS, "ended") }));
    const report = await prune({ keep: 1 });
    expect(report.plan.map((d) => d.entry.name)).toEqual([`${TASK}-1`]);
    expect(report.skipped).toEqual([]);
    expect(left()).toEqual(
      [
        `${OTHER}-1`,
        `${OTHER}-2`,
        `${OTHER}-3`,
        `${TASK}-0`,
        `${TASK}-01`,
        `${TASK}-1`,
        `${TASK}z-1`,
      ].sort(),
    );
  });

  test("never follows a run folder that is a link, nor removes what it leads to", async () => {
    dated(1, HOUR_MS);
    const target = join(stateDir, "outside");
    mkdirSync(target);
    writeFileSync(
      join(target, "run.json"),
      JSON.stringify(record(`${TASK}-2`, 40 * DAY_MS, "ended")),
    );
    symlinkSync(target, join(runsDir, `${TASK}-2`));
    writeFileSync(join(runsDir, `${TASK}-3`), "a file");
    const report = await prune();
    expect(report.plan.map((d) => d.entry.name)).toEqual([`${TASK}-1`]);
    expect(report.skipped).toEqual([
      { path: join(runsDir, `${TASK}-2`), reason: "a symlink, never followed" },
      { path: join(runsDir, `${TASK}-3`), reason: "a file, not a run folder" },
    ]);
    expect(existsSync(join(target, "run.json"))).toBe(true);
    expect(left()).toEqual([`${TASK}-1`, `${TASK}-2`, `${TASK}-3`]);
  });

  test("refuses a runs folder that is a link, removing nothing", async () => {
    const real = join(stateDir, "real-runs");
    mkdirSync(real);
    const old = join(real, `${TASK}-1`);
    mkdirSync(old);
    writeFileSync(
      join(old, "run.json"),
      JSON.stringify(record(`${TASK}-1`, 400 * DAY_MS, "ended")),
    );
    rmSync(runsDir, { recursive: true });
    symlinkSync(real, runsDir);
    const report = await prune();
    expect(report.removed).toEqual([]);
    expect(report.failed).toEqual([
      { path: runsDir, error: expect.stringMatching(/not a folder/) },
    ]);
    expect(existsSync(old)).toBe(true);
  });

  test("removes an interrupted removal's leftover once its grace has passed, as the suite does", async () => {
    const stale = join(
      runsDir,
      `.pruning-${String(NOW - LEFTOVER_GRACE_MS - 1)}-1-abcdef01`,
    );
    const fresh = join(runsDir, `.pruning-${String(NOW - 1000)}-1-abcdef02`);
    mkdirSync(stale);
    writeFileSync(join(stale, "run.log"), "half removed");
    mkdirSync(fresh);
    // A link named like a leftover is not one: never followed, never removed.
    const target = join(stateDir, "keep-me");
    mkdirSync(target);
    const link = join(
      runsDir,
      `.pruning-${String(NOW - LEFTOVER_GRACE_MS - 1)}-1-abcdef03`,
    );
    symlinkSync(target, link);
    const report = await prune();
    expect(report.leftovers).toEqual([{ path: stale, bytes: 12 }]);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(link)).toBe(true);
    expect(existsSync(target)).toBe(true);
  });

  test("reports, never throws: no runs folder, a bad task, a relative state directory, a bad cap", async () => {
    rmSync(runsDir, { recursive: true });
    const none = await prune();
    expect(none.plan).toEqual([]);
    expect(none.failed).toEqual([]);
    mkdirSync(runsDir);
    dated(1, 400 * DAY_MS);
    for (const given of [
      { taskId: "bp" },
      { stateDir: "relative/state" },
      { keep: -1 },
    ]) {
      const report = await prune(given);
      expect(report.failed, JSON.stringify(given)).toHaveLength(1);
      expect(report.removed).toEqual([]);
    }
    expect(left()).toEqual([`${TASK}-1`]);
  });

  test("says what went in one line, and each failure and skipped entry in its own", async () => {
    for (let n = 1; n <= 3; n++) dated(n, (4 - n) * HOUR_MS);
    dated(4, 31 * DAY_MS);
    symlinkSync(stateDir, join(runsDir, `${TASK}-9`));
    const report = await prune({ keep: 1 });
    const show = (path: string): string => relative(stateDir, path);
    const lines = describeRunRetention(report, show);
    expect(lines).toEqual([
      {
        text: expect.stringMatching(
          /^pruned 3 run folders, [\d.]+ k?B — 2 beyond the newest 1 \(runs\.reportsKeep\), 1 older than 30 days$/,
        ),
        warn: false,
      },
      {
        text: `left runs/${TASK}-9 alone — a symlink, never followed`,
        warn: true,
      },
    ]);
    expect(
      describeRunRetention(
        {
          ...report,
          removed: [],
          skipped: [],
          failed: [{ path: join(stateDir, "runs"), error: "EACCES" }],
        },
        show,
      ),
    ).toEqual([{ text: "could not prune runs — EACCES", warn: true }]);
    expect(
      describeRunRetention(
        { ...report, removed: [], skipped: [], failed: [] },
        show,
      ),
    ).toEqual([]);
  });
});
