import { test, expect } from "@playwright/test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import {
  STREAM_BEGAN_AT,
  makeRun,
  removeTempRoot,
  tempRoot,
} from "../__fixtures__/report-tree";
import {
  DAY_MS,
  DEFAULT_RETENTION,
  LEFTOVER_GRACE_MS,
  applyRetention,
  describeReason,
  formatBytes,
  formatSpan,
  isoInstant,
  listGroupRuns,
  listReportRuns,
  outsideRoot,
  planRetention,
  removeLeftovers,
  type RetentionDecision,
  type RetentionEntry,
  type RetentionPolicy,
} from "./retention";

/**
 * Report retention: the planner's every rule and boundary on synthetic entries with a fixed `now`,
 * then the listing and the removal on real temporary trees — links, leftovers, failures.
 */

/** The fixed time every planner case measures against. */
const NOW = Date.parse("2026-10-12T12:00:00.000Z");

/** A run started `ageMs` before {@link NOW}; complete and non-empty unless told otherwise. */
function entry(
  name: string,
  ageMs: number,
  facts: Partial<Pick<RetentionEntry, "empty" | "complete">> & {
    readonly group?: string;
  } = {},
): RetentionEntry & { readonly group: string } {
  return {
    path: `/r/${facts.group ?? "p/c"}/${name}`,
    time: NOW - ageMs,
    empty: facts.empty ?? false,
    complete: facts.complete ?? true,
    group: facts.group ?? "p/c",
  };
}

/** A policy: the suite's, with `overrides`. */
function policy(overrides: Partial<RetentionPolicy> = {}): RetentionPolicy {
  return { ...DEFAULT_RETENTION, ...overrides };
}

/** Plans `entries` and returns each run's `name → action:reason`, in the plan's order. */
function plan(
  entries: readonly (RetentionEntry & { readonly group: string })[],
  rules: RetentionPolicy = policy(),
  protectedPaths: readonly string[] = [],
): [string, string][] {
  return planRetention(entries, rules, NOW, (e) => e.group, protectedPaths).map(
    (d) => [d.entry.path.split("/").at(-1) ?? "", `${d.action}:${d.reason}`],
  );
}

const X = DEFAULT_RETENTION.maxAgeMs;
const Y = DEFAULT_RETENTION.keepNewestCompleteForMs;
const MIN = 60_000;

test.describe("planRetention — the policy, case by case", () => {
  test("1. an empty group plans nothing", () => {
    expect(plan([])).toEqual([]);
  });

  test("2. a lone fresh complete run is kept as the newest complete report", () => {
    expect(plan([entry("a", MIN)])).toEqual([["a", "keep:newest-complete"]]);
  });

  test("3. FIFO: with keep + 1 fresh runs, only the oldest goes, beyond the cap", () => {
    const runs = [1, 2, 3].map((n) =>
      entry(`r${String(n)}`, n * MIN, { complete: n !== 1 }),
    );
    expect(plan(runs, policy({ keep: 2 }))).toEqual([
      ["r1", "keep:within-policy"],
      ["r2", "keep:newest-complete"],
      ["r3", "delete:beyond-cap"],
    ]);
  });

  test("4. a run exactly X old is kept; a millisecond more and it goes", () => {
    const fresh = entry("fresh", MIN);
    expect(plan([fresh, entry("x", X)])).toEqual([
      ["fresh", "keep:newest-complete"],
      ["x", "keep:within-policy"],
    ]);
    expect(plan([fresh, entry("x", X + 1)])).toEqual([
      ["fresh", "keep:newest-complete"],
      ["x", "delete:too-old"],
    ]);
  });

  test("5. X below one day is read as one day: nothing under a day old goes for its age", () => {
    const rules = policy({ maxAgeMs: 60 * MIN });
    const fresh = entry("fresh", MIN);
    expect(plan([fresh, entry("h2", 2 * 60 * MIN)], rules)[1]).toEqual([
      "h2",
      "keep:within-policy",
    ]);
    expect(plan([fresh, entry("d", DAY_MS)], rules)[1]).toEqual([
      "d",
      "keep:within-policy",
    ]);
    expect(plan([fresh, entry("d1", DAY_MS + 1)], rules)[1]).toEqual([
      "d1",
      "delete:too-old",
    ]);
  });

  test("6. the newest complete report outlives X", () => {
    expect(
      plan([entry("killed", MIN, { complete: false }), entry("old", X * 2)]),
    ).toEqual([
      ["killed", "keep:within-policy"],
      ["old", "keep:newest-complete"],
    ]);
  });

  test("7. ... up to exactly Y; a millisecond more and it goes", () => {
    expect(plan([entry("y", Y)])).toEqual([["y", "keep:newest-complete"]]);
    expect(plan([entry("y1", Y + 1)])).toEqual([["y1", "delete:too-old"]]);
  });

  test("8. only the newest complete report is excepted: an older complete one beyond X goes", () => {
    expect(
      plan([entry("new", X + DAY_MS), entry("older", X + 2 * DAY_MS)]),
    ).toEqual([
      ["new", "keep:newest-complete"],
      ["older", "delete:too-old"],
    ]);
  });

  test("9. the cap never removes the newest complete report: N + 1 runs at most", () => {
    const killed = [1, 2, 3].map((n) =>
      entry(`k${String(n)}`, n * MIN, { complete: false }),
    );
    expect(
      plan(
        [...killed, entry("done", 4 * MIN), entry("older", 5 * MIN)],
        policy({ keep: 3 }),
      ),
    ).toEqual([
      ["k1", "keep:within-policy"],
      ["k2", "keep:within-policy"],
      ["k3", "keep:within-policy"],
      ["done", "keep:newest-complete"],
      ["older", "delete:beyond-cap"],
    ]);
  });

  test("10. killed runs count toward the cap", () => {
    expect(
      plan(
        [
          entry("done", MIN),
          entry("killed", 2 * MIN, { complete: false }),
          entry("old", 3 * MIN),
        ],
        policy({ keep: 2 }),
      ),
    ).toEqual([
      ["done", "keep:newest-complete"],
      ["killed", "keep:within-policy"],
      ["old", "delete:beyond-cap"],
    ]);
  });

  test("11. a group of killed runs only: the cap and X apply, nothing is excepted", () => {
    const runs = [1, 2, 3].map((n) =>
      entry(`k${String(n)}`, n * MIN, { complete: false }),
    );
    expect(
      plan(
        [...runs, entry("ancient", X + 1, { complete: false })],
        policy({ keep: 2 }),
      ),
    ).toEqual([
      ["k1", "keep:within-policy"],
      ["k2", "keep:within-policy"],
      ["k3", "delete:beyond-cap"],
      ["ancient", "delete:too-old"],
    ]);
  });

  test("12. an empty run goes, and takes no place under the cap", () => {
    const decisions = planRetention(
      [
        entry("r1", MIN),
        entry("list", 2 * MIN, { empty: true }),
        entry("r2", 3 * MIN),
      ],
      policy({ keep: 2 }),
      NOW,
      (e) => e.group,
    );
    expect(decisions.map((d) => [d.action, d.reason, d.rank])).toEqual([
      ["keep", "newest-complete", 0],
      ["delete", "empty", undefined],
      ["keep", "within-policy", 1],
    ]);
  });

  test("13. an empty run is never the newest complete report, nor kept for being one", () => {
    expect(
      plan([
        entry("list", MIN, { empty: true, complete: true }),
        entry("real", X * 2),
      ]),
    ).toEqual([
      ["list", "delete:empty"],
      ["real", "keep:newest-complete"],
    ]);
  });

  test("14. a protected run is kept — beyond the cap, past X, or empty — and still counts", () => {
    const runs = [
      entry("newer", MIN),
      entry("current", 2 * MIN),
      entry("third", 3 * MIN),
    ];
    expect(plan(runs, policy({ keep: 1 }), ["/r/p/c/current"])).toEqual([
      ["newer", "keep:newest-complete"],
      ["current", "keep:protected"],
      ["third", "delete:beyond-cap"],
    ]);
    expect(
      plan([entry("old", X * 10, { complete: false })], policy(), [
        "/r/p/c/old",
      ]),
    ).toEqual([["old", "keep:protected"]]);
    expect(
      plan([entry("list", MIN, { empty: true })], policy(), ["/r/p/c/list/"]),
    ).toEqual([["list", "keep:protected"]]);
  });

  test("15. a future-dated run is kept, takes no place under the cap, and is never the newest complete report", () => {
    expect(
      plan(
        [
          entry("future", -DAY_MS),
          entry("later", -365 * DAY_MS),
          entry("now", MIN, { complete: false }),
          entry("real", 2 * MIN),
          entry("old", 3 * MIN),
        ],
        policy({ keep: 2 }),
      ),
    ).toEqual([
      ["later", "keep:future"],
      ["future", "keep:future"],
      ["now", "keep:within-policy"],
      // The newest complete report of the runs that have happened: a skewed clock cannot take it.
      ["real", "keep:newest-complete"],
      ["old", "delete:beyond-cap"],
    ]);
  });

  test("16. keep = 0 sets no cap; the age rules still apply", () => {
    const runs = Array.from({ length: 30 }, (_, n) =>
      entry(`r${String(n).padStart(2, "0")}`, (n + 1) * MIN),
    );
    const decisions = plan([...runs, entry("old", X + 1)], policy({ keep: 0 }));
    expect(decisions.filter(([, d]) => d.startsWith("delete"))).toEqual([
      ["old", "delete:too-old"],
    ]);
  });

  test("17. groups are planned apart, each with its own cap and newest complete report", () => {
    const decisions = plan(
      [
        entry("b1", MIN, { group: "p/b" }),
        entry("a1", MIN, { group: "p/a" }),
        entry("b2", 2 * MIN, { group: "p/b" }),
        entry("a2", 2 * MIN, { group: "p/a", complete: false }),
        entry("a3", 3 * MIN, { group: "p/a", complete: false }),
      ],
      policy({ keep: 2 }),
    );
    expect(decisions).toEqual([
      ["a1", "keep:newest-complete"],
      ["a2", "keep:within-policy"],
      ["a3", "delete:beyond-cap"],
      ["b1", "keep:newest-complete"],
      ["b2", "keep:within-policy"],
    ]);
  });

  test("18. an undated run is kept, last, and takes no place under the cap", () => {
    const undated = { ...entry("undated", 0), time: Number.NaN };
    const decisions = planRetention(
      [undated, entry("r1", MIN), entry("r2", 2 * MIN)],
      policy({ keep: 2 }),
      NOW,
      (e) => e.group,
    );
    expect(decisions.map((d) => [d.entry.path, d.reason, d.rank])).toEqual([
      ["/r/p/c/r1", "newest-complete", 0],
      ["/r/p/c/r2", "within-policy", 1],
      ["/r/p/c/undated", "undated", undefined],
    ]);
  });

  test("19. ties are broken by path, so a plan never depends on the input's order", () => {
    const a = entry("a", MIN);
    const b = entry("b", MIN);
    const c = entry("c", MIN);
    const rules = policy({ keep: 2 });
    expect(plan([a, b, c], rules)).toEqual(plan([c, a, b], rules));
    expect(plan([a, b, c], rules).at(-1)).toEqual(["a", "delete:beyond-cap"]);
  });

  test("20. the planner is pure: its input is left as it was", () => {
    const runs = [entry("r2", 2 * MIN), entry("r1", MIN)];
    const copy = structuredClone(runs);
    plan(runs, policy({ keep: 1 }));
    expect(runs).toEqual(copy);
  });
});

test.describe("the words", () => {
  test("describeReason names the policy's numbers", () => {
    const rules = policy({ keep: 7, maxAgeMs: 3 * DAY_MS });
    const say = (reason: RetentionDecision["reason"]): string =>
      describeReason(reason, rules);
    expect(say("beyond-cap")).toBe("beyond the newest 7");
    expect(say("too-old")).toBe("older than 3 days");
    expect(describeReason("too-old", policy({ maxAgeMs: 1 }))).toBe(
      "older than 1 day",
    );
    expect(say("newest-complete")).toBe("the newest complete report");
    expect(say("empty")).toBe("empty (--list, or no tests found)");
  });

  test("isoInstant reads only the suite's own UTC instants", () => {
    expect(isoInstant("2026-10-12T00:00:00.000Z")).toBe(
      Date.parse("2026-10-12T00:00:00.000Z"),
    );
    for (const value of [
      "1",
      "2026-10-12",
      "2026-10-12T00:00:00.000",
      "2026-10-12T00:00:00Z",
      "2026-10-12T00:00:00.000+00:00",
      "2026-02-30T00:00:00.000Z",
      " 2026-10-12T00:00:00.000Z",
    ]) {
      expect(isoInstant(value), value).toBeNaN();
    }
  });

  test("formatSpan and formatBytes", () => {
    expect(formatSpan(30 * DAY_MS)).toBe("30 days");
    expect(formatSpan(DAY_MS)).toBe("1 day");
    expect(formatSpan(36 * 60 * MIN)).toBe("36 hours");
    expect(formatSpan(90 * MIN)).toBe("90 minutes");
    expect(formatSpan(1500)).toBe("2 seconds");
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(4_300_000)).toBe("4.3 MB");
    expect(formatBytes(711_500_000)).toBe("711.5 MB");
    expect(formatBytes(1_200_000_000)).toBe("1.2 GB");
  });
});

test.describe("listReportRuns — on a real tree", () => {
  let root = "";

  test.beforeEach(() => {
    root = tempRoot("e2e-retention-");
  });

  test.afterEach(() => {
    // A test may leave a folder unwritable; give it back before removing the tree.
    execFileSync("chmod", ["-R", "u+rwx", root]);
    removeTempRoot(root);
  });

  test("finds each run, dated by its RUN_ID or its stream, and skips everything else with its reason", () => {
    const cell = join(root, "backwpup", "pro@nginx");
    makeRun(cell, "2026-10-01T00-00-00-000Z-1");
    // A pinned RUN_ID no parser reads: dated by its stream, never by its files.
    makeRun(cell, "nightly", { mtimeMs: Date.parse("2026-09-01T00:00:00Z") });
    makeRun(cell, "nightly-killed", { stream: "none" });
    writeFileSync(join(cell, "allure-history.jsonl"), "{}\n");
    writeFileSync(join(root, "backwpup", "stray.txt"), "");
    mkdirSync(join(cell, "not-a-run"));
    writeFileSync(join(cell, "not-a-run", "notes.txt"), "");
    mkdirSync(join(cell, ".hidden"));
    // A run's folder elsewhere, linked in: listed as a link, never entered.
    const outside = join(root, "outside");
    makeRun(outside, "2026-10-02T00-00-00-000Z-2");
    symlinkSync(
      join(outside, "2026-10-02T00-00-00-000Z-2"),
      join(cell, "linked-run"),
    );
    symlinkSync(outside, join(root, "backwpup", "linked-cell"));
    // A folder whose only "report part" is a link is not a run.
    mkdirSync(join(cell, "only-a-link"));
    symlinkSync(
      join(outside, "2026-10-02T00-00-00-000Z-2", "playwright"),
      join(cell, "only-a-link", "playwright"),
    );

    const listing = listReportRuns(root, { product: "backwpup" });
    expect(listing.groups).toEqual(["backwpup/pro@nginx"]);
    expect(
      listing.runs.map((r) => [r.name, r.group, r.timeSource, r.time]),
    ).toEqual([
      [
        "2026-10-01T00-00-00-000Z-1",
        "backwpup/pro@nginx",
        "run-id",
        Date.parse("2026-10-01T00:00:00Z"),
      ],
      ["nightly", "backwpup/pro@nginx", "stream", Date.parse(STREAM_BEGAN_AT)],
    ]);
    const skipped = Object.fromEntries(
      listing.skipped.map((s) => [s.path.slice(root.length + 1), s.reason]),
    );
    expect(skipped).toEqual({
      "backwpup/linked-cell": "a symlink, never followed",
      "backwpup/stray.txt": "a file, not a run",
      "backwpup/pro@nginx/.hidden": "hidden",
      "backwpup/pro@nginx/allure-history.jsonl": "a file, not a run",
      "backwpup/pro@nginx/linked-run": "a symlink, never followed",
      "backwpup/pro@nginx/nightly-killed":
        "not a run: its name is no RUN_ID, and no results stream dates it",
      "backwpup/pro@nginx/not-a-run": "holds no report part",
      "backwpup/pro@nginx/only-a-link": "holds no report part",
    });
  });

  test("tells an empty run by its stream, and a complete one by its Playwright index", () => {
    const cell = join(root, "p", "c");
    // RUN_ID names, so a run without a readable stream is still a run; the suffix says which.
    const at = (label: string): string =>
      join(cell, `2026-10-01T00-00-00-000Z-${label}`);
    const make = (label: string, run?: Parameters<typeof makeRun>[2]): void => {
      makeRun(cell, `2026-10-01T00-00-00-000Z-${label}`, run);
    };
    make("list", { stream: "list" });
    make("no-tests", { stream: "no-tests" });
    make("real", { stream: "test" });
    make("pre-stream", { stream: "none" });
    make("killed", { complete: false });
    make("blank-index", { complete: false });
    writeFileSync(join(at("blank-index"), "playwright", "index.html"), "");
    // A stream that is a link reads as no stream: a run is never judged by a file outside it.
    make("linked-stream", { stream: "none" });
    symlinkSync(
      join(at("list"), "results.jsonl"),
      join(at("linked-stream"), "results.jsonl"),
    );
    // A FIFO named like the stream must not hang the listing.
    make("fifo", { stream: "none" });
    execFileSync("mkfifo", [join(at("fifo"), "results.jsonl")]);
    // Only the first line counts: a `run.begin` below a line of something else is no `run.begin`.
    make("late-begin", { stream: "none" });
    writeFileSync(
      join(at("late-begin"), "results.jsonl"),
      "not json\n" + readFileSync(join(at("list"), "results.jsonl"), "utf8"),
    );
    // A Playwright folder that is a link does not make a run complete.
    make("linked-report", { complete: false });
    renameSync(
      join(at("linked-report"), "playwright"),
      join(at("linked-report"), "pw-real"),
    );
    symlinkSync(
      join(at("real"), "playwright"),
      join(at("linked-report"), "playwright"),
    );

    const facts = Object.fromEntries(
      listReportRuns(root).runs.map((r) => [
        r.name.slice("2026-10-01T00-00-00-000Z-".length),
        [r.empty, r.complete],
      ]),
    );
    expect(facts).toEqual({
      list: [true, false],
      "no-tests": [true, false],
      real: [false, true],
      "pre-stream": [false, true],
      killed: [false, false],
      "blank-index": [false, false],
      "linked-stream": [false, true],
      fifo: [false, true],
      "late-begin": [false, true],
      "linked-report": [false, false],
    });
  });

  test("a folder of someone else's is never a run: a REPORT_ROOT set to a repository removes nothing", () => {
    // The shape of a checkout: `node_modules/<package>/<folder>` holding a `cucumber` folder and
    // `assets/img/icons` an `allure` one — each where a run sits, two levels below the root. Dated
    // 1985, as npm extracts: by its files' age, every one would have gone.
    const old = Date.parse("1985-10-26T08:15:00Z");
    for (const folder of ["dist", "src"]) {
      const path = join(root, "node_modules", "playwright-bdd", folder);
      mkdirSync(join(path, "cucumber"), { recursive: true });
      writeFileSync(join(path, "cucumber", "index.js"), "code");
      utimesSync(path, new Date(old), new Date(old));
    }
    mkdirSync(join(root, "assets", "img", "icons", "allure"), {
      recursive: true,
    });
    utimesSync(
      join(root, "assets", "img", "icons"),
      new Date(old),
      new Date(old),
    );
    const listing = listReportRuns(root);
    expect(listing.runs).toEqual([]);
    expect(
      listing.skipped
        .filter(({ reason }) => reason.startsWith("not a run"))
        .map(({ path }) => path.slice(root.length + 1)),
    ).toEqual([
      "assets/img/icons",
      "node_modules/playwright-bdd/dist",
      "node_modules/playwright-bdd/src",
    ]);
    const report = applyRetention(
      planRetention(
        listing.runs,
        policy({ keep: 1 }),
        Date.parse("2100-01-01T00:00:00Z"),
        (run) => run.group,
      ),
      root,
    );
    expect(report.removed).toEqual([]);
    expect(
      existsSync(join(root, "node_modules", "playwright-bdd", "dist")),
    ).toBe(true);
  });

  test("an unreadable cell or run folder is skipped, and the listing goes on", () => {
    makeRun(join(root, "p", "locked"), "r");
    makeRun(join(root, "p", "open"), "r");
    const lockedRun = makeRun(join(root, "p", "open"), "locked-run");
    chmodSync(join(root, "p", "locked"), 0o000);
    chmodSync(lockedRun, 0o000);
    try {
      const listing = listReportRuns(root);
      expect(listing.runs.map((r) => r.group + "/" + r.name)).toEqual([
        "p/open/r",
      ]);
      expect(listing.skipped).toEqual([
        { path: join(root, "p", "locked"), reason: "unreadable (EACCES)" },
        { path: lockedRun, reason: "unreadable" },
      ]);
    } finally {
      chmodSync(join(root, "p", "locked"), 0o755);
      chmodSync(lockedRun, 0o755);
    }
  });

  test("a stream whose run.begin is not dated as the suite writes it dates nothing", () => {
    const cell = join(root, "p", "c");
    for (const [name, at] of [
      ["zoneless", "2026-10-01T00:00:00"],
      ["number", "1"],
    ] as const) {
      const run = makeRun(cell, name, { stream: "none" });
      writeFileSync(
        join(run, "results.jsonl"),
        `${JSON.stringify({ v: 1, type: "run.begin", at, runId: name, product: "p", cell: "c", mode: "test", scenarios: 1, setups: 0, retries: 0, workers: 1 })}\n`,
      );
    }
    const listing = listGroupRuns(cell, "p/c");
    expect(listing.runs).toEqual([]);
    expect(listing.skipped.map((s) => s.reason)).toEqual([
      "not a run: its name is no RUN_ID, and no results stream dates it",
      "not a run: its name is no RUN_ID, and no results stream dates it",
    ]);
  });

  test("lists in-removal folders as leftovers, never as runs", () => {
    const cell = join(root, "p", "c");
    makeRun(cell, ".pruning-1760000000000-42-0a1b2c3d");
    const listing = listGroupRuns(cell, "p/c");
    expect(listing.runs).toEqual([]);
    expect(listing.leftovers).toEqual([
      {
        path: join(cell, ".pruning-1760000000000-42-0a1b2c3d"),
        since: 1760000000000,
      },
    ]);
  });

  test("filters by product and cell; a missing root or group lists nothing; a root that is a file throws", () => {
    makeRun(join(root, "a", "x"), "r");
    makeRun(join(root, "a", "y"), "r");
    makeRun(join(root, "b", "x"), "r");
    expect(listReportRuns(root, { cell: "x" }).groups).toEqual(["a/x", "b/x"]);
    expect(listReportRuns(root, { product: "a", cell: "y" }).groups).toEqual([
      "a/y",
    ]);
    expect(listReportRuns(join(root, "absent")).runs).toEqual([]);
    expect(listGroupRuns(join(root, "a", "absent"), "a/absent").groups).toEqual(
      [],
    );
    writeFileSync(join(root, "file"), "");
    expect(() => listReportRuns(join(root, "file"))).toThrow(/not a folder/);
  });

  test("follows the root itself when it is a link", () => {
    makeRun(join(root, "real", "p", "c"), "r");
    symlinkSync(join(root, "real"), join(root, "link"));
    expect(listReportRuns(join(root, "link")).runs.map((r) => r.path)).toEqual([
      join(root, "link", "p", "c", "r"),
    ]);
  });
});

test.describe("applyRetention — on a real tree", () => {
  let root = "";
  let cell = "";

  test.beforeEach(() => {
    root = tempRoot("e2e-retention-apply-");
    cell = join(root, "p", "c");
  });

  test.afterEach(() => {
    execFileSync("chmod", ["-R", "u+rwx", root]);
    removeTempRoot(root);
  });

  /** Plans the cell with `keep` and a fixed now well after every run. */
  function planCell(keep: number): RetentionDecision[] {
    return planRetention(
      listGroupRuns(cell, "p/c").runs,
      policy({ keep }),
      Date.parse("2026-10-12T00:00:00Z"),
      () => "p/c",
    );
  }

  test("removes each doomed run, measures it, confirms it gone, and touches nothing else", () => {
    makeRun(cell, "2026-10-11T00-00-00-000Z-1", { bytes: 1000 });
    makeRun(cell, "2026-10-10T00-00-00-000Z-1", { bytes: 2000 });
    writeFileSync(join(cell, "allure-history.jsonl"), "{}\n");
    const report = applyRetention(planCell(1), root);
    expect(report.failed).toEqual([]);
    expect(report.removed.map((r) => r.decision.entry.path)).toEqual([
      join(cell, "2026-10-10T00-00-00-000Z-1"),
    ]);
    // Its 2000 bytes of padding, its index and its stream's line.
    expect(report.removed[0]?.bytes).toBeGreaterThan(2000);
    expect(report.removed[0]?.bytes).toBeLessThan(2500);
    expect(readdirSync(cell).sort()).toEqual([
      "2026-10-11T00-00-00-000Z-1",
      "allure-history.jsonl",
    ]);
  });

  test("unlinks a link inside a run, leaving its target intact", () => {
    const target = join(root, "precious");
    mkdirSync(target);
    writeFileSync(join(target, "keep.txt"), "keep");
    makeRun(cell, "2026-10-11T00-00-00-000Z-1");
    const doomed = makeRun(cell, "2026-10-10T00-00-00-000Z-1");
    symlinkSync(target, join(doomed, "allure-results", "link-to-dir"));
    symlinkSync(join(target, "keep.txt"), join(doomed, "link-to-file"));
    const report = applyRetention(planCell(1), root);
    expect(report.removed).toHaveLength(1);
    expect(existsSync(doomed)).toBe(false);
    expect(readFileSync(join(target, "keep.txt"), "utf8")).toBe("keep");
  });

  test("a run already gone is reported as gone; one replaced by a link is left alone", () => {
    makeRun(cell, "2026-10-12T00-00-00-000Z-1");
    const gone = makeRun(cell, "2026-10-11T00-00-00-000Z-1");
    const swapped = makeRun(cell, "2026-10-10T00-00-00-000Z-1");
    const decisions = planCell(1);
    removeTempRoot(gone);
    // Swapped for a link between the listing and the removal.
    const target = join(root, "target");
    renameSync(swapped, target);
    symlinkSync(target, swapped);
    const report = applyRetention(decisions, root);
    expect(report.gone).toEqual([gone]);
    expect(report.removed).toEqual([]);
    expect(report.failed).toEqual([
      {
        path: swapped,
        error: "no longer a folder (a link or a file now): left alone",
      },
    ]);
    expect(existsSync(join(target, "playwright", "index.html"))).toBe(true);
  });

  test("a run that cannot be set aside is reported, never thrown, and left whole", () => {
    makeRun(cell, "2026-10-11T00-00-00-000Z-1");
    const doomed = makeRun(cell, "2026-10-10T00-00-00-000Z-1");
    const decisions = planCell(1);
    chmodSync(cell, 0o555);
    const report = applyRetention(decisions, root);
    chmodSync(cell, 0o755);
    expect(report.removed).toEqual([]);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]?.error).toMatch(
      /^could not set it aside, nothing removed: /,
    );
    expect(existsSync(join(doomed, "playwright", "index.html"))).toBe(true);
  });

  test("a removal that stops part-way is reported, hidden, and finished by a later prune", () => {
    makeRun(cell, "2026-10-11T00-00-00-000Z-1");
    const doomed = makeRun(cell, "2026-10-10T00-00-00-000Z-1");
    // Its Playwright folder's entries cannot be removed.
    chmodSync(join(doomed, "playwright"), 0o555);
    const now = Date.parse("2026-10-12T00:00:00Z");
    const report = applyRetention(planCell(1), root, now);
    expect(report.removed).toEqual([]);
    expect(report.failed[0]?.error).toMatch(
      /^removed in part; the rest is in \.pruning-\d+-\d+-[0-9a-f]{8}, which a later prune removes: /,
    );
    // Out of sight: no listing shows the half-removed run.
    const listing = listGroupRuns(cell, "p/c");
    expect(listing.runs.map((r) => r.name)).toEqual([
      "2026-10-11T00-00-00-000Z-1",
    ]);
    expect(listing.leftovers).toHaveLength(1);
    const [leftover] = listing.leftovers;
    if (leftover === undefined) throw new Error("no leftover");
    chmodSync(join(leftover.path, "playwright"), 0o755);
    // Too young: another prune may still be at it.
    expect(
      removeLeftovers(listing.leftovers, root, now + LEFTOVER_GRACE_MS - 1)
        .removed,
    ).toEqual([]);
    const later = removeLeftovers(
      listing.leftovers,
      root,
      now + LEFTOVER_GRACE_MS,
    );
    expect(later.failed).toEqual([]);
    expect(later.removed.map((r) => r.path)).toEqual([leftover.path]);
    expect(readdirSync(cell)).toEqual(["2026-10-11T00-00-00-000Z-1"]);
  });

  test("a cell folder swapped for a link after the listing redirects nothing out of the report tree", () => {
    makeRun(cell, "2026-10-11T00-00-00-000Z-1");
    const doomed = makeRun(cell, "2026-10-10T00-00-00-000Z-1");
    const decisions = planCell(1);
    // A folder of the same name elsewhere, reached once the cell folder is a link to its parent.
    const outside = join(root, "outside");
    const victim = makeRun(outside, "2026-10-10T00-00-00-000Z-1");
    renameSync(cell, join(root, "p", "moved"));
    symlinkSync(outside, cell);
    const report = applyRetention(decisions, root);
    expect(report.removed).toEqual([]);
    expect(report.failed).toEqual([
      {
        path: doomed,
        error:
          "its folder now leads outside the report root (a link): left alone",
      },
    ]);
    expect(existsSync(join(victim, "playwright", "index.html"))).toBe(true);
  });

  test("a leftover whose folder now leads outside the report root is left alone", () => {
    const outside = join(root, "outside");
    const name = ".pruning-1760000000000-42-0a1b2c3d";
    makeRun(outside, name);
    mkdirSync(join(root, "p"), { recursive: true });
    symlinkSync(outside, cell);
    const report = removeLeftovers(
      [{ path: join(cell, name), since: 1760000000000 }],
      root,
      1760000000000 + LEFTOVER_GRACE_MS,
    );
    expect(report.removed).toEqual([]);
    expect(report.failed).toHaveLength(1);
    expect(existsSync(join(outside, name, "playwright"))).toBe(true);
  });

  test("outsideRoot: below a linked root is inside; the root, its own children, above it, or an unresolvable folder is not", () => {
    makeRun(cell, "r");
    const link = join(root, "link");
    symlinkSync(root, link);
    expect(outsideRoot(join(cell, "r"), root)).toBeUndefined();
    expect(outsideRoot(join(link, "p", "c", "r"), link)).toBeUndefined();
    // A folder in the root itself is no run's: a run sits two folders below it.
    expect(outsideRoot(join(root, "r"), root)).toBe(
      "not below the report root: left alone",
    );
    expect(outsideRoot(root, root)).toBe(
      "not below the report root: left alone",
    );
    expect(outsideRoot(join(root, "..", "x", "r"), root)).toBe(
      "not below the report root: left alone",
    );
    expect(outsideRoot(join(root, "absent", "r"), root)).toMatch(
      /^its folder cannot be resolved, left alone: /,
    );
  });

  test("keep decisions are never acted on", () => {
    const kept = makeRun(cell, "2026-10-11T00-00-00-000Z-1");
    const report = applyRetention(planCell(0), root);
    expect(report).toEqual({ removed: [], gone: [], failed: [] });
    expect(existsSync(kept)).toBe(true);
  });
});
