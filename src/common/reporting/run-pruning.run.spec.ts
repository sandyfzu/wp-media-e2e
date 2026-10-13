import { test, expect } from "@playwright/test";
import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

import { makeRun } from "../__fixtures__/report-tree";
import { formatRunId } from "../config/run-id";
import { RESULTS_FILE } from "./results-schema";

/**
 * A run's own pruning through the real `bddgen`, runner and reporter stack, offline: that the config
 * hands the summary the cap, that the summary's `onExit` prunes the run's cell once every report is
 * written, and what each way a run ends does — a pass, a failure and a run interrupted by one SIGINT
 * prune, `--list` and a killed run do not, the run after a killed one does. Another cell's folder and the `_all` bucket are never
 * touched, and a bad `E2E_REPORTS_KEEP` fails the run at its start.
 *
 * A synthetic product runs `__fixtures__/results/results.feature` on a placeholder site, so its
 * setups skip and nothing leaves the machine. Everything lands in a temporary folder.
 */

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const FIXTURE_DIR = join(REPO_ROOT, "src/common/__fixtures__/results");
const PRODUCT = "pruneprobe";

/** How long one child may take: `bddgen`, or a run of a few short scenarios. */
const CHILD_TIMEOUT_MS = 90_000;

let work = "";

/** The report folder of a cell. */
function cellDir(cell: string): string {
  return join(work, "reports", PRODUCT, cell);
}

/** The run folders of a cell, oldest first (their names sort by time). */
function runsOf(cell: string): string[] {
  return existsSync(cellDir(cell))
    ? readdirSync(cellDir(cell))
        .filter((name) => !name.endsWith(".jsonl"))
        .sort()
    : [];
}

test.beforeAll(() => {
  // Its real path: playwright-bdd compares the feature's path to the config's resolved folder.
  work = realpathSync(mkdtempSync(join(tmpdir(), "e2e-prune-run-")));
  writeFileSync(join(work, "package.json"), '{ "type": "module" }\n');
  symlinkSync(join(REPO_ROOT, "node_modules"), join(work, "node_modules"));
  mkdirSync(join(work, "src"));
  symlinkSync(join(REPO_ROOT, "src", "common"), join(work, "src", "common"));
  copyFileSync(
    join(FIXTURE_DIR, "results.feature"),
    join(work, "results.feature"),
  );
  writeFileSync(join(work, "playwright.config.ts"), configSource(work));
});

test.afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

/** The synthetic product's config: cell `x` on a placeholder site. */
function configSource(dir: string): string {
  const product = {
    name: PRODUCT,
    features: join(dir, "results.feature"),
    steps: [
      join(REPO_ROOT, "src/common/fixtures.ts"),
      join(FIXTURE_DIR, "*.steps.ts"),
    ],
    sites: {
      x: {
        sites: [
          {
            baseURL: "https://x.example.test",
            username: "u",
            password: "p",
            transport: { mode: "local", rootDir: dir },
          },
        ],
      },
    },
    artifacts: {
      project: PRODUCT,
      defaultRef: { plugin: "develop" },
      version: { kind: "embedded" },
      edition: {
        kind: "editionless",
        identity: {
          slug: PRODUCT,
          mainFile: `${PRODUCT}.php`,
          pluginName: "Prune probe",
        },
      },
    },
  };
  const factory = JSON.stringify(
    join(REPO_ROOT, "src/common/config/project.ts"),
  );
  return (
    `import { createProductConfig } from ${factory};\n` +
    `export default createProductConfig(${JSON.stringify(product)});\n`
  );
}

/** A run's environment, built — nothing inherited from this worker's own Playwright variables. */
function runEnv(runId: string, keep: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    E2E_LOAD_DOTENV: "false",
    E2E_CELL: "x",
    E2E_RETRIES: "0",
    E2E_REPORTS_KEEP: keep,
    RUN_ID: runId,
    REPORT_ROOT: join(work, "reports"),
    OUTPUT_ROOT: join(work, "test-results"),
    AUTH_ROOT: join(work, "auth"),
    ARTIFACTS_ROOT: join(work, "artifacts"),
  };
}

/** The node entry of a CLI in the repository's `node_modules`. */
function cli(path: string): string {
  return join(REPO_ROOT, "node_modules", path);
}

/** What one run left. */
interface RunOutcome {
  readonly exitCode: number | null;
  /** Its stdout and stderr, colours stripped. */
  readonly output: string;
  readonly runId: string;
}

/**
 * Runs cell `x` as the orchestrator does — `bddgen`, then the runner in a process group of its own —
 * and, with `stop`, stops it once the hanging scenario has begun: `SIGKILL` to the group, or one
 * `SIGINT` to the runner (the orchestrator's graceful stop).
 *
 * @param args - the runner's extra arguments.
 * @param stop - how to stop the run mid-scenario, if at all.
 * @param keep - `E2E_REPORTS_KEEP`.
 */
async function runCell(
  args: readonly string[],
  stop?: "SIGKILL" | "SIGINT",
  keep = "2",
): Promise<RunOutcome> {
  const runId = formatRunId(new Date(), "probe");
  const env = runEnv(runId, keep);
  const generated = spawnSync(
    process.execPath,
    [cli("playwright-bdd/dist/cli/index.js"), "-c", "playwright.config.ts"],
    { cwd: work, env, encoding: "utf8", timeout: CHILD_TIMEOUT_MS },
  );
  if (generated.status !== 0) {
    return {
      exitCode: generated.status,
      output: stripVTControlCharacters(generated.stderr + generated.stdout),
      runId,
    };
  }
  const child = spawn(
    process.execPath,
    [
      cli("@playwright/test/cli.js"),
      "test",
      "-c",
      "playwright.config.ts",
      ...args,
    ],
    { cwd: work, env, detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8").on("data", (chunk: string) => {
      output += chunk;
    });
  }
  const exited = new Promise<number | null>((resolve) => {
    child.on("exit", (code) => {
      resolve(code);
    });
  });
  const killGroup = (): void => {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
    } catch {
      // The group is gone already.
    }
  };
  const timer = setTimeout(killGroup, CHILD_TIMEOUT_MS);
  try {
    if (stop !== undefined) {
      await waitForHang(runId);
      if (stop === "SIGKILL") killGroup();
      else child.kill("SIGINT");
    }
    const exitCode = await exited;
    return { exitCode, output: stripVTControlCharacters(output), runId };
  } finally {
    clearTimeout(timer);
    killGroup();
  }
}

/** Polls the run's stream until the hanging scenario has begun. */
async function waitForHang(runId: string): Promise<void> {
  const stream = join(cellDir("x"), runId, RESULTS_FILE);
  const deadline = Date.now() + CHILD_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (existsSync(stream) && readFileSync(stream, "utf8").includes("hangs")) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("the hanging scenario never began");
}

test("a run prunes its own cell as it ends: a pass, a failure, after a kill, an interrupted run; never --list or a killed run", async () => {
  test.setTimeout(8 * CHILD_TIMEOUT_MS);
  // Neighbours that must never be touched: another cell's runs, and the bucket of runs of every cell.
  const neighbours = ["y", "_all"].flatMap((cell) =>
    [
      "2026-01-01T00-00-00-000Z-1",
      "2026-01-02T00-00-00-000Z-1",
      "2026-01-03T00-00-00-000Z-1",
    ].map((name) => makeRun(cellDir(cell), name)),
  );
  const passes = ["--grep", "A scenario that passes"];

  const a = await runCell(passes);
  const b = await runCell(passes);
  expect([a.exitCode, b.exitCode]).toEqual([0, 0]);
  expect(runsOf("x")).toEqual([a.runId, b.runId]);
  expect(b.output).not.toContain("Pruned");

  // The third run fails, and still prunes: the oldest goes, the new run counts.
  const c = await runCell(["--grep", "fails on every attempt"]);
  expect(c.exitCode).toBe(1);
  expect(c.output).toMatch(
    /\n {2}Pruned {6}1 old report, [\d.]+ [kM]?B — beyond the newest 2 \(E2E_REPORTS_KEEP\)\n$/,
  );
  expect(runsOf("x")).toEqual([b.runId, c.runId]);

  // --list runs nothing, so it prunes nothing; its own folder is an empty run.
  const d = await runCell([...passes, "--list"]);
  expect(d.exitCode).toBe(0);
  expect(d.output).not.toContain("Pruned");
  expect(runsOf("x")).toEqual([b.runId, c.runId, d.runId]);

  // A killed run never reaches its end: it prunes nothing.
  const e = await runCell(["--grep", "hangs"], "SIGKILL");
  expect(e.exitCode).toBeNull();
  expect(runsOf("x")).toEqual([b.runId, c.runId, d.runId, e.runId]);

  // The next run prunes for it: the empty --list run and everything beyond the newest two (the
  // killed run counts).
  const f = await runCell(passes);
  expect(f.exitCode).toBe(0);
  expect(f.output).toMatch(
    /Pruned {6}3 old reports, [\d.]+ [kM]?B — 1 empty \(--list, or no tests found\), 2 beyond the newest 2 \(E2E_REPORTS_KEEP\)\n$/,
  );
  expect(runsOf("x")).toEqual([e.runId, f.runId]);

  // One SIGINT — the orchestrator's graceful stop — interrupts the run, which still ends and prunes:
  // the killed run goes, beyond the cap. Its own report is written to the end, so it is complete.
  const g = await runCell(["--grep", "hangs"], "SIGINT");
  expect(g.exitCode).toBe(130);
  expect(g.output).toMatch(
    /\n {2}Pruned {6}1 old report, [\d.]+ [kM]?B — beyond the newest 2 \(E2E_REPORTS_KEEP\)\n$/,
  );
  expect(runsOf("x")).toEqual([f.runId, g.runId]);
  expect(
    existsSync(join(cellDir("x"), g.runId, "playwright", "index.html")),
  ).toBe(true);
  expect(neighbours.every((path) => existsSync(path))).toBe(true);

  // A command-line --reporter replaces the summary, and its pruning with it: even at a cap of 1,
  // nothing goes (and such a run writes no report folder of its own).
  const h = await runCell([...passes, "--reporter=line"], undefined, "1");
  expect(h.exitCode).toBe(0);
  expect(h.output).not.toContain("Pruned");
  expect(runsOf("x")).toEqual([f.runId, g.runId]);

  // A bad cap fails the run at its start, naming the variable — before any report is written.
  const bad = await runCell(passes, undefined, "lots");
  expect(bad.exitCode).not.toBe(0);
  expect(bad.output).toContain(
    'Environment variable "E2E_REPORTS_KEEP" must be an integer in [0, 10000], got "lots"',
  );
  expect(runsOf("x")).toEqual([f.runId, g.runId]);
});
