import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { makeRun, removeTempRoot, tempRoot } from "../__fixtures__/report-tree";
import {
  EXIT,
  parsePruneArgs,
  parseSpan,
  runPrune,
  type PruneOptions,
} from "./prune-command";
import { DAY_MS, DEFAULT_RETENTION } from "./retention";

/**
 * `npm run report:prune`: its strict parser, the command on real temporary trees — dry run, apply,
 * a failed removal, a scope that names nothing — and the entry point's exit codes.
 */

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

test.describe("parseSpan", () => {
  test("a whole number and m, h, d or w", () => {
    expect(parseSpan("90m")).toBe(90 * 60_000);
    expect(parseSpan("36h")).toBe(36 * 3_600_000);
    expect(parseSpan("30d")).toBe(30 * DAY_MS);
    expect(parseSpan("26w")).toBe(182 * DAY_MS);
    expect(parseSpan("999999m")).toBe(999_999 * 60_000);
  });

  test("anything else is refused", () => {
    for (const text of [
      "",
      "30",
      "d",
      "0d",
      "-1d",
      "+1d",
      "1.5d",
      "1D",
      " 1d",
      "1d ",
      "01d",
      "1s",
      "1y",
      "1000000m",
      "1e3d",
    ]) {
      expect(parseSpan(text), JSON.stringify(text)).toBeUndefined();
    }
  });
});

test.describe("parsePruneArgs", () => {
  /** The options a command line gives, or fails the test. */
  function options(argv: string[], defaultKeep = 20): PruneOptions {
    const parsed = parsePruneArgs(argv, defaultKeep);
    if (parsed.kind !== "run") throw new Error(JSON.stringify(parsed));
    return parsed.options;
  }

  /** The error a command line gives. */
  function error(argv: string[]): string {
    const parsed = parsePruneArgs(argv, 20);
    return parsed.kind === "error"
      ? parsed.message
      : `not an error: ${parsed.kind}`;
  }

  test("no arguments: a dry run of the suite's policy, with the default cap", () => {
    expect(options([], 7)).toEqual({
      apply: false,
      policy: { ...DEFAULT_RETENTION, keep: 7 },
    });
  });

  test("every option, in both forms", () => {
    expect(
      options([
        "--apply",
        "--keep",
        "0",
        "--older-than=2w",
        "--keep-newest-for",
        "90d",
        "--product=backwpup",
        "--cell",
        "_all",
      ]),
    ).toEqual({
      apply: true,
      policy: {
        keep: 0,
        maxAgeMs: 14 * DAY_MS,
        keepNewestCompleteForMs: 90 * DAY_MS,
      },
      product: "backwpup",
      cell: "_all",
    });
    expect(options(["--keep=10000"]).policy.keep).toBe(10_000);
    expect(options(["--older-than", "1d"]).policy.maxAgeMs).toBe(DAY_MS);
    expect(options(["--cell", "pro@nginx"]).cell).toBe("pro@nginx");
  });

  test("help, wherever it is", () => {
    expect(parsePruneArgs(["--keep", "3", "-h"], 20).kind).toBe("help");
    expect(parsePruneArgs(["--help"], 20).kind).toBe("help");
  });

  test("an error names what is wrong", () => {
    const cases: [string[], RegExp][] = [
      [["--keep"], /^--keep needs a value$/],
      [["--keep", "--apply"], /^--keep needs a value$/],
      [["--keep", "-1"], /^--keep needs a value$/],
      [["--keep=-1"], /^--keep must be a whole number from 0 to 10000/],
      [["--keep", "10001"], /^--keep must be/],
      [["--keep", "1.5"], /^--keep must be/],
      [["--keep", "0x10"], /^--keep must be/],
      [["--keep="], /^--keep must be/],
      [["--older-than", "12h"], /^--older-than must be at least 1d/],
      [
        ["--older-than", "30"],
        /^--older-than must be a whole number and m, h, d or w/,
      ],
      [["--keep-newest-for", "6mo"], /^--keep-newest-for must be/],
      [["--product", "../x"], /^--product must be one folder name/],
      [["--cell", ".hidden"], /^--cell must be one folder name/],
      [["--cell=a/b"], /^--cell must be one folder name/],
      [["--keep", "1", "--keep", "2"], /^--keep is given twice$/],
      [["--apply", "--apply"], /^--apply is given twice$/],
      [["--apply=yes"], /^unknown option "--apply=yes"$/],
      [["--dry-run"], /^unknown option "--dry-run"$/],
      [["-k", "3"], /^unknown option "-k"$/],
      [["backwpup"], /^unexpected argument "backwpup"$/],
    ];
    for (const [argv, message] of cases) {
      expect(error(argv), argv.join(" ")).toMatch(message);
    }
  });
});

test.describe("runPrune — on a real tree", () => {
  let root = "";
  let lines: string[] = [];
  const io = {
    print: (line: string): void => {
      lines.push(line);
    },
    // Elsewhere: paths are shown absolute.
    cwd: "/elsewhere",
  };
  const NOW = Date.parse("2026-10-12T00:00:00.000Z");

  test.beforeEach(() => {
    root = tempRoot("e2e-prune-command-");
    lines = [];
    const cell = join(root, "backwpup", "pro@nginx");
    makeRun(cell, "2026-10-11T00-00-00-000Z-1", { bytes: 1000 });
    makeRun(cell, "2026-10-10T00-00-00-000Z-1", { bytes: 2000 });
    makeRun(cell, "2026-08-01T00-00-00-000Z-1", { bytes: 3000 });
    writeFileSync(join(cell, "allure-history.jsonl"), "{}\n");
    writeFileSync(join(cell, ".DS_Store"), "");
    makeRun(join(root, "wp-rocket", "apache"), "2026-10-11T00-00-00-000Z-2");
  });

  test.afterEach(() => {
    removeTempRoot(root);
  });

  /** Options with the suite's policy and `fields`. */
  function opts(fields: Partial<PruneOptions> = {}): PruneOptions {
    return { apply: false, policy: DEFAULT_RETENTION, ...fields };
  }

  test("a dry run says what would go, with its reason and size, and removes nothing", () => {
    expect(runPrune(opts(), root, NOW, io)).toBe(EXIT.ok);
    const out = lines.join("\n");
    expect(out).toContain("a dry run: nothing is removed without --apply");
    expect(out).toContain(
      "backwpup/pro@nginx — 3 runs: 2 kept, 1 to remove (3.2 kB)",
    );
    expect(out).toMatch(
      /remove {2}2026-08-01T00-00-00-000Z-1 +3\.2 kB {2}older than 30 days/,
    );
    expect(out).toMatch(
      /keep {4}2026-10-11T00-00-00-000Z-1 .*the newest complete report/,
    );
    expect(out).toContain("allure-history.jsonl — a file, not a run");
    expect(out).toContain("  and 1 hidden entry");
    expect(out).not.toContain(".DS_Store");
    expect(out).toMatch(/Would remove 1 of 4 runs, 3\.2 kB of [\d.]+ kB\./);
    expect(
      existsSync(
        join(root, "backwpup", "pro@nginx", "2026-08-01T00-00-00-000Z-1"),
      ),
    ).toBe(true);
  });

  test("a pinned RUN_ID's run is dated by its stream, and says so; a folder no run made is only listed", () => {
    const cell = join(root, "wp-rocket", "apache");
    makeRun(cell, "nightly");
    makeRun(cell, "copied-by-hand", { stream: "none" });
    expect(runPrune(opts(), root, NOW, io)).toBe(EXIT.ok);
    const out = lines.join("\n");
    expect(out).toMatch(/keep {4}nightly .*\(dated by its stream\)$/m);
    expect(out).toContain(
      "copied-by-hand — not a run: its name is no RUN_ID, and no results stream dates it",
    );
  });

  test("--apply removes, and says what it freed", () => {
    const code = runPrune(
      opts({ apply: true, policy: { ...DEFAULT_RETENTION, keep: 1 } }),
      root,
      NOW,
      io,
    );
    expect(code).toBe(EXIT.ok);
    expect(lines.at(-1)).toMatch(
      /^Planned 2 of 4 runs, .*\. Removed 2 runs, [\d.]+ kB\.$/,
    );
    expect(readdirSync(join(root, "backwpup", "pro@nginx")).sort()).toEqual([
      ".DS_Store",
      "2026-10-11T00-00-00-000Z-1",
      "allure-history.jsonl",
    ]);
    expect(readdirSync(join(root, "wp-rocket", "apache"))).toHaveLength(1);
  });

  test("--product and --cell narrow it; one that names nothing is a usage error", () => {
    expect(runPrune(opts({ product: "wp-rocket" }), root, NOW, io)).toBe(
      EXIT.ok,
    );
    expect(lines.join("\n")).not.toContain("backwpup");
    lines = [];
    expect(
      runPrune(opts({ product: "backwpup", cell: "apache" }), root, NOW, io),
    ).toBe(EXIT.usage);
    expect(lines).toEqual([
      `No report folder for product "backwpup" and cell "apache" under ${root}.`,
    ]);
  });

  test("a removal that fails: exit 1, the failure printed, the rest removed", () => {
    const cell = join(root, "backwpup", "pro@nginx");
    chmodSync(join(cell, "2026-08-01T00-00-00-000Z-1", "playwright"), 0o555);
    try {
      const code = runPrune(
        opts({ apply: true, policy: { ...DEFAULT_RETENTION, keep: 1 } }),
        root,
        NOW,
        io,
      );
      expect(code).toBe(EXIT.failed);
    } finally {
      for (const name of readdirSync(cell)) {
        if (name.startsWith(".pruning-"))
          chmodSync(join(cell, name, "playwright"), 0o755);
      }
    }
    expect(lines.join("\n")).toMatch(
      /could not remove .*2026-08-01T00-00-00-000Z-1 — removed in part/,
    );
    expect(existsSync(join(cell, "2026-10-10T00-00-00-000Z-1"))).toBe(false);
  });

  test("a report root it cannot read: exit 1; one that does not exist: nothing to do", () => {
    writeFileSync(join(root, "file"), "");
    expect(runPrune(opts(), join(root, "file"), NOW, io)).toBe(EXIT.failed);
    expect(lines[0]).toMatch(
      /^Could not read the reports under .*file: .*not a folder/,
    );
    lines = [];
    expect(runPrune(opts(), join(root, "absent"), NOW, io)).toBe(EXIT.ok);
    expect(lines.at(-1)).toBe(
      "Would remove 0 of 0 runs, 0 B of 0 B. Pass --apply to remove them.",
    );
  });
});

test.describe("prune-reports.ts — the entry point", () => {
  /** Runs `npm run report:prune`'s script with these arguments and variables. */
  function prune(
    args: string[],
    env: Record<string, string>,
  ): { status: number | null; stdout: string; stderr: string } {
    const child = spawnSync(
      process.execPath,
      [
        join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs"),
        "prune-reports.ts",
        ...args,
      ],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        timeout: 30_000,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          E2E_LOAD_DOTENV: "false",
          ...env,
        },
      },
    );
    return { status: child.status, stdout: child.stdout, stderr: child.stderr };
  }

  test("exit 0 for a dry run, 2 for a bad argument or a bad E2E_REPORTS_KEEP", () => {
    const root = tempRoot("e2e-prune-cli-");
    try {
      makeRun(join(root, "p", "c"), "2026-10-11T00-00-00-000Z-1");
      const ok = prune([], { REPORT_ROOT: root });
      expect(ok.status, ok.stderr).toBe(0);
      expect(ok.stdout).toContain("Would remove 0 of 1 runs");

      const bad = prune(["--keep", "x"], { REPORT_ROOT: root });
      expect(bad.status).toBe(2);
      expect(bad.stderr).toContain(
        'report:prune: --keep must be a whole number from 0 to 10000, got "x".',
      );

      const env = prune([], { REPORT_ROOT: root, E2E_REPORTS_KEEP: "-1" });
      expect(env.status).toBe(2);
      expect(env.stderr).toContain(
        '"E2E_REPORTS_KEEP" must be an integer in [0, 10000], got "-1"',
      );

      const help = prune(["--help"], { REPORT_ROOT: root });
      expect(help.status).toBe(0);
      expect(help.stdout).toContain("Usage: npm run report:prune");
    } finally {
      removeTempRoot(root);
    }
  });
});
