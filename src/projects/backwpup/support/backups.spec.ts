import { test, expect } from "@playwright/test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BACKUP_TIMEOUT_MS,
  allowForBackup,
  countBackups,
  isJobRunning,
  listBackups,
  listJobs,
  outcomeOf,
  readLastRunLog,
  readLastRunOutcome,
  startJobInBackground,
  waitForBackup,
} from "./backups";
import type { LocalTransport } from "../../../common/config/types";

// A stub `wp` on PATH exercises these readers plus the real exec layer, with no WordPress. The
// scenario is chosen per test via $WP_STUB_MODE. Payloads mirror the field names the commands
// document (src/Cli/Commands/Backup.php and Job.php at the ref under test), including WP-CLI's
// habit of emitting numeric fields as strings.
const STUB_WP = `#!/usr/bin/env bash
case "$WP_STUB_MODE" in
  empty)        printf '[]' ;;
  empty-string) printf '' ;;
  backups)
    printf '%s' '[{"name":"2026-07-30_09-12-44_ABC123_DBDUMP.tar.gz","time":"July 30, 2026 @ 9:12 am","size":"1.20 MB","storage":"folder","type":"dbdump","job_id":"3","size_bytes":"1258291","time_unix":"1785402764"}]' ;;
  backups-no-optional)
    printf '%s' '[{"name":"a.tar","time":"t","size":"s","storage":"folder","type":"dbdump"}]' ;;
  backups-numeric)
    printf '%s' '[{"name":"a.tar","time":"t","size":"s","storage":"folder","type":"dbdump","job_id":7,"size_bytes":42,"time_unix":99}]' ;;
  backups-bad-number)
    printf '%s' '[{"name":"a.tar","time":"t","size":"s","storage":"folder","type":"dbdump","size_bytes":"not-a-number"}]' ;;
  jobs)
    printf '%s' '[{"job_id":"3","name":"Database","active_type":"wpcron","type":"DBDUMP","storages":"FOLDER","cron":"0 3 * * *","last_run":"never","last_runtime":"-"}]' ;;
  jobs-numeric)
    printf '%s' '[{"job_id":3,"name":"Database","active_type":"wpcron","type":"DBDUMP","storages":"FOLDER","cron":"0 3 * * *","last_run":"never","last_runtime":"-"}]' ;;
  not-json)   printf 'Error: Something exploded' ;;
  not-array)  printf '{"name":"x"}' ;;
  count)      printf '4' ;;
  count-bad)  printf 'many' ;;
  fail)       printf 'Error: boom' >&2; exit 1 ;;
  running)     printf '1' ;;
  not-running) printf '0' ;;
  gibberish)   printf 'who knows' ;;
  # The status column is assembled from the counts in the site's own language, so it can read
  # "O.K." while the counts say otherwise. The readers judge on the integers.
  log-errors)   printf '%s' '[{"name":"backwpup_log_a.html","errors":"2","warnings":"0","status":"O.K."}]' ;;
  log-warnings) printf '%s' '[{"name":"backwpup_log_b.html","errors":0,"warnings":3}]' ;;
  log-clean)    printf '%s' '[{"name":"backwpup_log_c.html","errors":0,"warnings":0}]' ;;
  log-none)     printf 'No logs found.' ;;
  # What the command prints once asked for the job as well, measured on a cell after an abort.
  log-named)    printf '%s' '[{"name":"backwpup_log_e7c378_2026-09-22_17-47-45.html","job_id":3,"errors":0,"warnings":2}]' ;;
  log-no-name)  printf '%s' '[{"job_id":3,"errors":0,"warnings":0}]' ;;
  # Counts that are present but carry no number. Coercing null or an empty string yields 0, so a
  # lenient read would report a run whose verdict is unknown as a clean one.
  log-null-counts)  printf '%s' '[{"name":"backwpup_log_d.html","errors":null,"warnings":null}]' ;;
  log-blank-counts) printf '%s' '[{"name":"backwpup_log_e.html","errors":"","warnings":""}]' ;;
  # run --background succeeds silently; the failing case is the command refusing to start a
  # second job, which is the one refusal a caller must not mistake for a start.
  started)    printf 'Success: Job "Database" runs now in background.' ;;
  already-running) printf 'Error: A job is already running.' >&2; exit 1 ;;
  # One archive appears on the second probe: the first --format=count reports the pre-run total,
  # every later one the new total. The status call then answers from WP_STUB_STATUS.
  grew)
    case "$1" in
      eval) printf '0' ;;                                   # nothing running
      *)
        case "$3" in
          *count*)
            if [ -f "$WP_STUB_PROBED" ]; then printf '2'; else touch "$WP_STUB_PROBED"; printf '1'; fi ;;
          *) printf '%s' "$WP_STUB_LOG" ;;                   # the run's log entry
        esac ;;
    esac ;;
  # The first count probe dies the way a dropped SSH connection does; every later one answers.
  flaky-count)
    case "$1" in
      eval) printf '0' ;;
      *)
        case "$3" in
          *count*)
            if [ -f "$WP_STUB_FLAKY_STATE" ]; then printf '1'
            else touch "$WP_STUB_FLAKY_STATE"; printf 'Error: connection closed by remote host' >&2; exit 1; fi ;;
          *) printf '%s' "$WP_STUB_LOG" ;;
        esac ;;
    esac ;;
esac
exit 0
`;

let binDir: string;
let rootDir: string;
let originalPath: string | undefined;
const transport: LocalTransport = { mode: "local", rootDir: "/tmp" };

test.beforeAll(() => {
  binDir = mkdtempSync(join(tmpdir(), "bwp-stub-bin-"));
  rootDir = mkdtempSync(join(tmpdir(), "bwp-stub-root-"));
  const wp = join(binDir, "wp");
  writeFileSync(wp, STUB_WP);
  chmodSync(wp, 0o755);
  originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
});

// The `grew` scenario remembers across invocations through this file, so each test starts from
// "nothing probed yet" rather than inheriting the previous one's second-probe state.
test.beforeEach(() => {
  process.env.WP_STUB_PROBED = join(binDir, "probed");
  rmSync(process.env.WP_STUB_PROBED, { force: true });
});

test.afterAll(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  delete process.env.WP_STUB_PROBED;
  delete process.env.WP_STUB_FLAKY_STATE;
  delete process.env.WP_STUB_STATUS;
  rmSync(binDir, { recursive: true, force: true });
  rmSync(rootDir, { recursive: true, force: true });
});

const local = (): LocalTransport => ({ mode: "local", rootDir });

test.describe("listBackups", () => {
  test("maps the documented fields and camel-cases the optional ones", async () => {
    process.env.WP_STUB_MODE = "backups";
    const [backup] = await listBackups(local());
    expect(backup).toEqual({
      name: "2026-07-30_09-12-44_ABC123_DBDUMP.tar.gz",
      time: "July 30, 2026 @ 9:12 am",
      size: "1.20 MB",
      storage: "folder",
      type: "dbdump",
      jobId: 3,
      sizeBytes: 1258291,
      timeUnix: 1785402764,
    });
  });

  test("accepts numeric fields emitted as numbers, not only as strings", async () => {
    process.env.WP_STUB_MODE = "backups-numeric";
    const [backup] = await listBackups(local());
    expect(backup?.jobId).toBe(7);
    expect(backup?.sizeBytes).toBe(42);
    expect(backup?.timeUnix).toBe(99);
  });

  // Absent optional fields must be absent, not present-as-NaN: a NaN would silently poison any
  // comparison a scenario made against it.
  test("omits optional fields the command did not return", async () => {
    process.env.WP_STUB_MODE = "backups-no-optional";
    const [backup] = await listBackups(local());
    expect(backup).not.toHaveProperty("jobId");
    expect(backup).not.toHaveProperty("sizeBytes");
    expect(backup).not.toHaveProperty("timeUnix");
  });

  test("drops an unparseable numeric field rather than yielding NaN", async () => {
    process.env.WP_STUB_MODE = "backups-bad-number";
    const [backup] = await listBackups(local());
    expect(backup).not.toHaveProperty("sizeBytes");
  });

  test("an empty history is an empty array", async () => {
    process.env.WP_STUB_MODE = "empty";
    expect(await listBackups(local())).toEqual([]);
  });

  test("an empty string is also an empty history", async () => {
    process.env.WP_STUB_MODE = "empty-string";
    expect(await listBackups(local())).toEqual([]);
  });

  // The whole point of these readers is to be a trustworthy second source. Returning [] for broken
  // output would turn a failed command into a passing "no backups yet" assertion.
  test("non-JSON output throws instead of reading as an empty history", async () => {
    process.env.WP_STUB_MODE = "not-json";
    await expect(listBackups(local())).rejects.toThrow(/did not return JSON/);
  });

  test("a JSON object rather than an array throws", async () => {
    process.env.WP_STUB_MODE = "not-array";
    await expect(listBackups(local())).rejects.toThrow(/expected a JSON array/);
  });

  test("a non-zero exit throws with the command's stderr", async () => {
    process.env.WP_STUB_MODE = "fail";
    await expect(listBackups(local())).rejects.toThrow(/exited 1: Error: boom/);
  });
});

test.describe("listJobs", () => {
  test("maps the documented job fields", async () => {
    process.env.WP_STUB_MODE = "jobs";
    const [job] = await listJobs(local());
    expect(job).toEqual({
      jobId: 3,
      name: "Database",
      activeType: "wpcron",
      type: "DBDUMP",
      storages: "FOLDER",
      cron: "0 3 * * *",
      lastRun: "never",
      lastRuntime: "-",
    });
  });

  test("accepts a job id that arrives as a number rather than a string", async () => {
    // WP-CLI emits numeric fields either way depending on the field's own type, so the reader must
    // not depend on which — the same case `listBackups` pins for its own optional numbers.
    process.env.WP_STUB_MODE = "jobs-numeric";
    const [job] = await listJobs(local());
    expect(job?.jobId).toBe(3);
  });
});

test.describe("countBackups", () => {
  test("returns the plugin's own count", async () => {
    process.env.WP_STUB_MODE = "count";
    expect(await countBackups(local())).toBe(4);
  });

  test("a non-integer count throws rather than yielding NaN", async () => {
    process.env.WP_STUB_MODE = "count-bad";
    await expect(countBackups(local())).rejects.toThrow(/expected an integer/);
  });
});

// The liveness probe reads the plugin's own running-file marker through `wp eval` and answers only
// `0` or `1`; these cover both, plus the replies that are neither and must fail rather than be
// guessed at.
test.describe("isJobRunning", () => {
  test("reads the plugin's own liveness marker", async () => {
    process.env.WP_STUB_MODE = "running";
    expect(await isJobRunning(local())).toBe(true);
    process.env.WP_STUB_MODE = "not-running";
    expect(await isJobRunning(local())).toBe(false);
  });

  test("throws rather than guessing when the answer is not 0 or 1", async () => {
    // A notice printed ahead of the value would otherwise be read as "not running" and let a
    // scenario uninstall the plugin out from under a live job.
    process.env.WP_STUB_MODE = "gibberish";
    await expect(isJobRunning(local())).rejects.toThrow(
      /could not tell whether a job is running/,
    );
  });
});

test.describe("readLastRunOutcome", () => {
  test("judges on the counts, not on the translated status column", async () => {
    // The stub's newest entry says `status: "O.K."` while carrying two errors — an entry the
    // plugin can genuinely produce, since that column is assembled from the counts in the site's
    // own language. Reading the column would call this run a success.
    process.env.WP_STUB_MODE = "log-errors";
    expect(await readLastRunOutcome(local())).toBe("errors");
  });

  test("reports warnings and clean runs apart", async () => {
    process.env.WP_STUB_MODE = "log-warnings";
    expect(await readLastRunOutcome(local())).toBe("warnings");
    process.env.WP_STUB_MODE = "log-clean";
    expect(await readLastRunOutcome(local())).toBe("finished");
  });

  test("throws when nothing has been logged, rather than calling it a success", async () => {
    process.env.WP_STUB_MODE = "empty";
    await expect(readLastRunOutcome(local())).rejects.toThrow(
      /no job log exists/,
    );
  });

  test("throws when the log cannot be read at all", async () => {
    process.env.WP_STUB_MODE = "fail";
    await expect(readLastRunOutcome(local())).rejects.toThrow(/exited 1/);
  });

  test("refuses a null count rather than reading it as a clean run", async () => {
    // `Number(null)` is 0, so a lenient coercion would turn "the counts are missing" into
    // "there were no errors" — the one mistake this reader must never make, because it passes a
    // failed backup.
    process.env.WP_STUB_MODE = "log-null-counts";
    await expect(readLastRunOutcome(local())).rejects.toThrow(
      /carries no error\/warning counts/,
    );
  });

  test("refuses an empty-string count as well", async () => {
    // `Number("")` is 0 too, and an empty field is a different reply from a null one, so it is
    // pinned separately.
    process.env.WP_STUB_MODE = "log-blank-counts";
    await expect(readLastRunOutcome(local())).rejects.toThrow(
      /carries no error\/warning counts/,
    );
  });
});

test.describe("readLastRunLog", () => {
  test("reports the log's name, the job its header names, and both counts", async () => {
    process.env.WP_STUB_MODE = "log-named";
    expect(await readLastRunLog(local())).toEqual({
      name: "backwpup_log_e7c378_2026-09-22_17-47-45.html",
      jobId: 3,
      errors: 0,
      warnings: 2,
    });
  });

  // Left out rather than defaulted: a job id of 0 would be indistinguishable from the one the
  // command reports for a header it could not read.
  test("leaves the job out when the reply names none", async () => {
    process.env.WP_STUB_MODE = "log-clean";
    expect(await readLastRunLog(local())).not.toHaveProperty("jobId");
  });

  test("refuses an entry that names no log file", async () => {
    process.env.WP_STUB_MODE = "log-no-name";
    await expect(readLastRunLog(local())).rejects.toThrow(/names no log file/);
  });
});

test.describe("outcomeOf", () => {
  test("lets an error outrank a warning", () => {
    expect(outcomeOf({ errors: 1, warnings: 3 })).toBe("errors");
    expect(outcomeOf({ errors: 0, warnings: 2 })).toBe("warnings");
    expect(outcomeOf({ errors: 0, warnings: 0 })).toBe("finished");
  });
});

test.describe("allowForBackup", () => {
  /** Enough of a TestInfo to record what the scenario's budget became. */
  const budget = (timeout: number) => {
    const info = {
      timeout,
      setTimeout: (next: number): void => {
        info.timeout = next;
      },
    };
    return info;
  };

  test("adds a backup's length to the scenario's budget, once per backup", () => {
    const info = budget(30_000);
    allowForBackup(info);
    expect(info.timeout).toBe(30_000 + BACKUP_TIMEOUT_MS);
    allowForBackup(info, 2);
    expect(info.timeout).toBe(30_000 + 3 * BACKUP_TIMEOUT_MS);
  });

  test("leaves a scenario with no timeout without one", () => {
    const info = budget(0);
    allowForBackup(info);
    expect(info.timeout).toBe(0);
  });
});

test.describe("startJobInBackground", () => {
  test("returns once the command has asked the site to run the job", async () => {
    process.env.WP_STUB_MODE = "started";
    await expect(startJobInBackground(transport, 3)).resolves.toBeUndefined();
  });

  test("throws when the command refuses — a job already running is not a start", async () => {
    process.env.WP_STUB_MODE = "already-running";
    await expect(startJobInBackground(transport, 3)).rejects.toThrow(
      /A job is already running/,
    );
  });
});

test.describe("waitForBackup", () => {
  test("waits for the count to grow past the baseline, then reports the verdict", async () => {
    // The count must *increase*, not merely be non-zero: a scenario that already had archives would
    // otherwise be told its new backup had landed before anything ran.
    process.env.WP_STUB_MODE = "grew";
    process.env.WP_STUB_LOG = '[{"name":"l.html","errors":0,"warnings":0}]';
    expect(await waitForBackup(transport, 1)).toBe("finished");
  });

  test("a site that cannot answer fails quickly, with the cause", async () => {
    // A site that never answers must not be reported ten minutes later as "no backup appeared", so
    // a run of consecutive failures ends the wait and re-raises the real error. Timed as well as
    // asserted: the tolerance must cost seconds, not the whole budget.
    process.env.WP_STUB_MODE = "fail";
    const started = Date.now();
    await expect(waitForBackup(transport, 0)).rejects.toThrow(/exited 1/);
    expect(Date.now() - started).toBeLessThan(30_000);
  });

  test("a probe that fails once does not end the wait", async () => {
    // `expect.poll` calls its function outside its own try/catch, so an unguarded probe that throws
    // ends the wait then and there. Over SSH, to a site busy writing a multi-gigabyte archive, one
    // lost connection is noise — this is the case that would otherwise surface as a WP-CLI error
    // in place of the thing being waited for.
    process.env.WP_STUB_MODE = "flaky-count";
    process.env.WP_STUB_FLAKY_STATE = join(binDir, "flaky-count");
    rmSync(process.env.WP_STUB_FLAKY_STATE, { force: true });
    process.env.WP_STUB_STATUS = "not-running";
    process.env.WP_STUB_LOG = '[{"name":"l.html","errors":0,"warnings":0}]';
    expect(await waitForBackup(transport, 0)).toBe("finished");
  });

  test("reports a failed run rather than throwing, leaving the judgement to the caller", async () => {
    // The regression this pins: the verdict now comes from the log, so a run that ended before it
    // could be watched is still judged — where asking `wp backwpup status` too late reported
    // "nothing was running" and every caller read that as "did not fail".
    process.env.WP_STUB_MODE = "grew";
    process.env.WP_STUB_LOG = '[{"name":"l.html","errors":1,"warnings":0}]';
    expect(await waitForBackup(transport, 1)).toBe("errors");
  });
});

test.describe("transport plumbing", () => {
  test("uses the transport it is given", async () => {
    process.env.WP_STUB_MODE = "empty";
    expect(await listBackups(transport)).toEqual([]);
  });
});
