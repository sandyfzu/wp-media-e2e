import { test, expect } from "@playwright/test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HISTORY_ROWS_PHP } from "./history";
import {
  RUN_STATE_PHP,
  parseRunState,
  runProgress,
  stopRunningJobs,
  waitForJobRunning,
  waitForRunToEnd,
} from "./job-runs";
import type { RunState, StopBudgets } from "./job-runs";
import type { LocalTransport } from "../../../common/config/types";

/**
 * The running-job reader, the two waits built on it, and the teardown's stop — driven over the real
 * exec layer by a stub `wp` that plays back a script of run states.
 *
 * The script has two halves, because the one thing that changes what a real site reports is being
 * told to stop: `before` is what `eval` answers until `backwpup kill` has been run, `after` what it
 * answers from then on. Each answer is one line of the script, and the last line repeats, which is
 * how a state that never changes is written. Every call is recorded, so a case can count the
 * questions and the stop requests it cost.
 */
const STUB_WP = `#!/usr/bin/env bash
if [ "$1" = "backwpup" ] && [ "$2" = "kill" ]; then
  printf 'backwpup kill\\n' >> "$WP_STUB_DIR/calls"
  touch "$WP_STUB_DIR/killed"
  printf 'Success: Job will be terminated.\\n'
  exit 0
fi
if [ "$1" = "eval" ]; then
  printf 'eval\\n' >> "$WP_STUB_DIR/calls"
  phase=before
  if [ -e "$WP_STUB_DIR/killed" ] && [ -e "$WP_STUB_DIR/after" ]; then phase=after; fi
  n=$(cat "$WP_STUB_DIR/$phase.count" 2>/dev/null || echo 0)
  total=$(grep -c '' "$WP_STUB_DIR/$phase")
  line=$(( n < total ? n + 1 : total ))
  sed -n "\${line}p" "$WP_STUB_DIR/$phase"
  echo $(( n + 1 )) > "$WP_STUB_DIR/$phase.count"
  exit 0
fi
exit 0
`;

let binDir: string;
let stubDir: string;
let originalPath: string | undefined;

test.beforeAll(() => {
  binDir = mkdtempSync(join(tmpdir(), "bwp-runs-bin-"));
  const wp = join(binDir, "wp");
  writeFileSync(wp, STUB_WP);
  chmodSync(wp, 0o755);
  originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
});

test.beforeEach(() => {
  stubDir = mkdtempSync(join(tmpdir(), "bwp-runs-state-"));
  process.env.WP_STUB_DIR = stubDir;
});

test.afterEach(() => {
  delete process.env.WP_STUB_DIR;
  rmSync(stubDir, { recursive: true, force: true });
});

test.afterAll(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  rmSync(binDir, { recursive: true, force: true });
});

const local = (): LocalTransport => ({ mode: "local", rootDir: stubDir });

/** A history row as `$wpdb` hands it over — every column a string. */
function row(status: string, jobId = "3"): Record<string, string> {
  return {
    filename: "2026-09-22_17-47-45_FJ4QJCUN03_DBDUMP.tar",
    destination: "FOLDER",
    job_id: jobId,
    status,
    backup_trigger: "backup_now_job",
  };
}

/** What the snippet prints: idle unless `running` names a job (`null`: marker read mid-write). */
function state(
  history: readonly Record<string, string>[] = [],
  running?: number | null,
): string {
  return JSON.stringify({
    loaded: true,
    running: running === undefined ? null : { job_id: running },
    history,
  });
}

const NOT_LOADED = JSON.stringify({ loaded: false });

/** Writes one half of the stub's script, one answer per line. */
function script(phase: "before" | "after", answers: readonly string[]): void {
  writeFileSync(join(stubDir, phase), `${answers.join("\n")}\n`);
}

/** The calls the stub answered, in order — `eval` or `backwpup kill`. */
function calls(): string[] {
  const file = join(stubDir, "calls");
  return existsSync(file)
    ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean)
    : [];
}

const kills = (): number =>
  calls().filter((call) => call === "backwpup kill").length;

/** Budgets small enough for a unit run, with room to spare for a slow machine. */
const QUICK: StopBudgets = {
  stopMs: 5_000,
  settleMs: 5_000,
  pollMs: 10,
  resendMs: 60_000,
};

test.describe("parseRunState", () => {
  test("reads an idle site and the history it holds", () => {
    const parsed = parseRunState(state([row("completed")]));
    expect(parsed).toEqual({
      loaded: true,
      history: [
        {
          filename: "2026-09-22_17-47-45_FJ4QJCUN03_DBDUMP.tar",
          destination: "FOLDER",
          jobId: 3,
          status: "completed",
          trigger: "backup_now_job",
        },
      ],
    });
    expect(parsed).not.toHaveProperty("running");
  });

  test("reads the job whose run holds the marker", () => {
    expect(parseRunState(state([row("created")], 3)).running).toEqual({
      jobId: 3,
    });
  });

  // The plugin rewrites the marker every second, and a read can land mid-write: still running,
  // job unknown — never "idle".
  test("reads a marker caught mid-write as a run whose job is unknown", () => {
    expect(parseRunState(state([], null)).running).toEqual({});
  });

  test("reads a site without the plugin as not loaded, with no history", () => {
    expect(parseRunState(NOT_LOADED)).toEqual({ loaded: false, history: [] });
  });

  // Each would otherwise have to be read as "nothing is running".
  test("refuses a reply that is not a run state", () => {
    expect(() => parseRunState("")).toThrow(/did not come back as JSON/);
    expect(() => parseRunState("{}")).toThrow(/expected a run state/);
    expect(() =>
      parseRunState(
        JSON.stringify({ loaded: true, running: "yes", history: [] }),
      ),
    ).toThrow(/integer job id/);
    expect(() =>
      parseRunState(
        JSON.stringify({ loaded: true, running: { job_id: "3" }, history: [] }),
      ),
    ).toThrow(/integer job id/);
    expect(() =>
      parseRunState(JSON.stringify({ loaded: true, running: null })),
    ).toThrow(/expected a list of rows/);
  });
});

test.describe("RUN_STATE_PHP", () => {
  test("answers for a site without the plugin instead of fataling", () => {
    expect(RUN_STATE_PHP).toContain("class_exists( 'BackWPup' )");
    expect(RUN_STATE_PHP).toContain("'loaded' => false");
  });

  test("names the running job from the marker's own working data", () => {
    expect(RUN_STATE_PHP).toContain("get_plugin_data( 'running_file' )");
    expect(RUN_STATE_PHP).toContain("BackWPup_Job::get_working_data()");
  });

  // The query that refuses a failed read, rather than one that would answer "no history".
  test("reads the history through the query that refuses a failed read", () => {
    expect(RUN_STATE_PHP).toContain(HISTORY_ROWS_PHP);
  });
});

test.describe("runProgress", () => {
  const at = (history: Record<string, string>[], running?: number | null) =>
    parseRunState(state(history, running));

  test("calls a run ended once nothing runs and the run recorded how", () => {
    expect(runProgress(at([row("completed")]), 3)).toBe("ended");
    expect(runProgress(at([row("aborted")]), 3)).toBe("ended");
  });

  test("does not while a run is still going", () => {
    expect(runProgress(at([row("created")], 3), 3)).toMatch(/still running/);
  });

  // The abort case: the marker is gone at once, the request finishes a second later.
  test("does not while the run is still recording its end", () => {
    expect(runProgress(at([row("created")]), 3)).toMatch(
      /still recording its end/,
    );
  });

  // A dispatched job starts a moment after the command that asked for it returns.
  test("does not mistake a run that has not started for one that has ended", () => {
    expect(runProgress(at([]), 3)).toMatch(/no run of job 3 is recorded yet/);
    expect(runProgress(at([row("completed", "5")]), 3)).toMatch(
      /no run of job 3/,
    );
  });

  test("does not when the plugin cannot be read at all", () => {
    const unloaded: RunState = { loaded: false, history: [] };
    expect(runProgress(unloaded, 3)).not.toBe("ended");
  });
});

test.describe("waitForJobRunning", () => {
  test("returns once the marker names the job", async () => {
    script("before", [state(), state([], null), state([row("created")], 3)]);
    await waitForJobRunning(local(), 3, 10_000);
    expect(calls()).toHaveLength(3);
  });

  test("does not settle for another job's run", async () => {
    script("before", [state([row("created", "5")], 5)]);
    await expect(waitForJobRunning(local(), 3, 1_000)).rejects.toThrow(
      /job 3 should be running/,
    );
  });
});

test.describe("waitForRunToEnd", () => {
  test("waits past a run that is still recording its end", async () => {
    script("before", [
      state([row("created")], 3),
      state([row("created")]),
      state([row("aborted")]),
    ]);
    await waitForRunToEnd(local(), 3, 20_000);
    expect(calls()).toHaveLength(3);
  });

  test("names where the run stood when it gives up", async () => {
    script("before", [state()]);
    await expect(waitForRunToEnd(local(), 3, 1_500)).rejects.toThrow(
      /no run of job 3 is recorded yet/,
    );
  });
});

test.describe("stopRunningJobs", () => {
  // The common case, paid on every scenario's teardown.
  test("asks one question and stops nothing on an idle site", async () => {
    script("before", [state([row("completed")])]);
    await expect(stopRunningJobs(local(), QUICK)).resolves.toBeUndefined();
    expect(calls()).toEqual(["eval"]);
  });

  test("stops nothing on a site whose plugin is gone", async () => {
    script("before", [NOT_LOADED]);
    await expect(stopRunningJobs(local(), QUICK)).resolves.toBeUndefined();
    expect(kills()).toBe(0);
  });

  test("tells a running job to stop, then waits for its run to record its end", async () => {
    script("before", [state([row("created")], 3)]);
    script("after", [
      state([row("created")]),
      state([row("created")]),
      state([row("aborted")]),
    ]);

    const stopped = await stopRunningJobs(local(), QUICK);

    expect(stopped).toBe(
      "a backup of job 3 was still running when the scenario ended; it was stopped before the " +
        "plugin was removed.",
    );
    expect(kills()).toBe(1);
    // Nothing more was asked once the run had recorded how it ended.
    expect(readFileSync(join(stubDir, "after.count"), "utf8").trim()).toBe("3");
  });

  // The plugin checks for its marker and rewrites it as two separate steps, so a stop that lands
  // between them is undone; asking again is what gets through.
  test("asks again when the job's marker comes back", async () => {
    script("before", [state([row("created")], 3)]);
    script("after", [
      ...Array.from({ length: 20 }, () => state([row("created")], 3)),
      state([row("aborted")]),
    ]);

    await stopRunningJobs(local(), { ...QUICK, resendMs: 20 });

    expect(kills()).toBeGreaterThan(1);
  });

  test("fails, naming what it found, when the job will not stop", async () => {
    script("before", [state([row("created")], 3)]);
    script("after", [state([row("created")], 3)]);

    await expect(
      stopRunningJobs(local(), { ...QUICK, stopMs: 300 }),
    ).rejects.toThrow(
      /a backup of job 3 was still running .* still running 0\.3 s after being told to stop — removing the plugin now would race it\. The last stop request: `wp backwpup kill` exited 0/,
    );
  });

  // Killed moments before the scenario ended: nothing left to stop, but the request is still
  // finishing, and removing the plugin under it is the race this exists to prevent.
  test("waits for a run to record its end even when nothing is running", async () => {
    script("before", [
      state([row("created")]),
      state([row("created")]),
      state([row("aborted")]),
    ]);

    const stopped = await stopRunningJobs(local(), QUICK);

    expect(stopped).toBe(
      "a run of job 3 was still recording its end when the scenario ended; it was left to finish " +
        "before the plugin was removed.",
    );
    expect(kills()).toBe(0);
  });

  // Nothing is running to finish it, so the plugin's removal races nothing: reported, not thrown.
  test("reports a run that never records its end, without failing", async () => {
    script("before", [state([row("created")])]);

    const stopped = await stopRunningJobs(local(), {
      ...QUICK,
      settleMs: 200,
    });

    expect(stopped).toMatch(
      /still recorded as in progress, with nothing left running to finish it\.$/,
    );
    expect(kills()).toBe(0);
  });

  test("names a job whose marker could not be read", async () => {
    script("before", [state([], null)]);
    script("after", [state([row("aborted")])]);

    expect(await stopRunningJobs(local(), QUICK)).toMatch(
      /^a backup of a job whose marker could not be read was still running/,
    );
  });
});
