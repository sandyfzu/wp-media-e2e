import { test, expect } from "@playwright/test";
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { makeRun, removeTempRoot, tempRoot } from "../__fixtures__/report-tree";
import { DEFAULT_RETENTION } from "./retention";
import {
  describePruning,
  pruneRunGroup,
  type PruneOutcome,
} from "./run-pruning";

/**
 * The pruning a run does as it ends: its own report folder's group only, itself protected, and the
 * lines the summary prints from it.
 */

const NOW = Date.parse("2026-10-12T12:00:00.000Z");

let root = "";

test.beforeEach(() => {
  root = tempRoot("e2e-run-pruning-");
});

test.afterEach(() => {
  removeTempRoot(root);
});

/** A run folder's name, `minutes` before {@link NOW}. */
function stamp(minutes: number): string {
  return new Date(NOW - minutes * 60_000)
    .toISOString()
    .replace(/[:.]/g, "-")
    .concat("-1");
}

test.describe("pruneRunGroup", () => {
  test("prunes the run's own group to the cap, never the run itself, never another group", () => {
    const cell = join(root, "wp-rocket", "apache");
    const other = join(root, "wp-rocket", "nginx");
    const all = join(root, "wp-rocket", "_all");
    for (const minutes of [10, 20, 30, 40]) makeRun(cell, stamp(minutes));
    for (const minutes of [10, 20, 30]) {
      makeRun(other, stamp(minutes));
      makeRun(all, stamp(minutes));
    }
    makeRun(cell, stamp(25), { stream: "list" });
    writeFileSync(join(cell, "allure-history.jsonl"), "{}\n");
    // The run in progress: the oldest name, so only protection keeps it.
    const current = makeRun(cell, stamp(50), { complete: false });

    const outcome = pruneRunGroup(current, 2, NOW);
    expect(outcome.failed).toEqual([]);
    expect(outcome.removed).toEqual([
      { reason: "empty", count: 1 },
      { reason: "beyond-cap", count: 2 },
    ]);
    expect(outcome.bytes).toBeGreaterThan(0);
    expect(readdirSync(cell).sort()).toEqual(
      [stamp(10), stamp(20), stamp(50), "allure-history.jsonl"].sort(),
    );
    expect(readdirSync(other)).toHaveLength(3);
    expect(readdirSync(all)).toHaveLength(3);
  });

  test("keep = 0: no cap, yet a run older than 30 days still goes", () => {
    const cell = join(root, "p", "c");
    for (const minutes of [10, 20, 30]) makeRun(cell, stamp(minutes));
    makeRun(cell, stamp(31 * 24 * 60), { complete: false });
    const current = makeRun(cell, stamp(1));
    const outcome = pruneRunGroup(current, 0, NOW);
    expect(outcome.policy).toEqual({ ...DEFAULT_RETENTION, keep: 0 });
    expect(outcome.removed).toEqual([{ reason: "too-old", count: 1 }]);
    expect(readdirSync(cell)).toHaveLength(4);
  });

  test("a group it cannot list is a failure in the outcome, never a throw", () => {
    const cell = join(root, "p", "c");
    const current = makeRun(cell, stamp(1));
    // A group folder nobody may read.
    chmodSync(cell, 0o000);
    let outcome: PruneOutcome;
    try {
      outcome = pruneRunGroup(current, 20, NOW);
    } finally {
      chmodSync(cell, 0o755);
    }
    expect(outcome.removed).toEqual([]);
    expect(outcome.failed).toHaveLength(1);
    expect(outcome.failed[0]?.path).toBe(cell);
    expect(outcome.failed[0]?.error).toMatch(/EACCES/);
  });
});

test.describe("pruneRunGroup — a path too short", () => {
  test("a path too short for <root>/<product>/<cell>/<RUN_ID> is refused before anything is listed", () => {
    for (const path of ["/run", "/c/run", "/"]) {
      expect(pruneRunGroup(path, 1, NOW), path).toEqual({
        policy: { ...DEFAULT_RETENTION, keep: 1 },
        removed: [],
        leftovers: 0,
        bytes: 0,
        failed: [{ path, error: "not inside <report root>/<product>/<cell>" }],
      });
    }
    expect(pruneRunGroup("/p/c/run", 1, NOW).failed).toEqual([]);
  });
});

test.describe("pruneRunGroup — links", () => {
  test("a product or cell folder that is a link is never followed: nothing pruned, a failure said", () => {
    const real = join(root, "real");
    for (const minutes of [10, 20, 30])
      makeRun(join(real, "c"), stamp(minutes));
    // The product folder is a link.
    symlinkSync(real, join(root, "linked-product"));
    const viaProduct = pruneRunGroup(
      join(root, "linked-product", "c", stamp(10)),
      1,
      NOW,
    );
    expect(viaProduct.failed).toEqual([
      { path: join(root, "linked-product"), error: "a link, never followed" },
    ]);
    // The cell folder is a link.
    mkdirSync(join(root, "p"));
    symlinkSync(join(real, "c"), join(root, "p", "c"));
    const viaCell = pruneRunGroup(join(root, "p", "c", stamp(10)), 1, NOW);
    expect(viaCell.failed[0]?.error).toMatch(/is a link, never followed$/);
    expect(readdirSync(join(real, "c"))).toHaveLength(3);
  });
});

test.describe("describePruning", () => {
  /** An outcome with these fields, nothing removed by default. */
  function outcome(fields: Partial<PruneOutcome>): PruneOutcome {
    return {
      policy: DEFAULT_RETENTION,
      removed: [],
      leftovers: 0,
      bytes: 0,
      failed: [],
      ...fields,
    };
  }
  const show = (path: string): string => `<${path}>`;

  test("nothing removed and nothing failed: no line at all", () => {
    expect(describePruning(outcome({}), show)).toEqual([]);
  });

  test("one reason: the count heads the line, the reason follows alone", () => {
    expect(
      describePruning(
        outcome({
          removed: [{ reason: "beyond-cap", count: 1 }],
          bytes: 4_300_000,
        }),
        show,
      ),
    ).toEqual([
      {
        text: "1 old report, 4.3 MB — beyond the newest 20 (E2E_REPORTS_KEEP)",
        warn: false,
      },
    ]);
  });

  test("several reasons, and leftovers, each with its count", () => {
    expect(
      describePruning(
        outcome({
          removed: [
            { reason: "beyond-cap", count: 2 },
            { reason: "too-old", count: 1 },
          ],
          leftovers: 1,
          bytes: 8_600_000,
        }),
        show,
      )[0]?.text,
    ).toBe(
      "3 old reports, 8.6 MB — 2 beyond the newest 20 (E2E_REPORTS_KEEP), 1 older than 30 days, 1 left by an interrupted removal",
    );
    expect(
      describePruning(outcome({ leftovers: 2, bytes: 10 }), show)[0]?.text,
    ).toBe("2 unfinished removals, 10 B — 2 left by an interrupted removal");
  });

  test("each failure is a warning naming the path as shown", () => {
    expect(
      describePruning(
        outcome({ failed: [{ path: "/r/p/c/run", error: "EACCES" }] }),
        show,
      ),
    ).toEqual([{ text: "could not prune </r/p/c/run> — EACCES", warn: true }]);
  });
});
