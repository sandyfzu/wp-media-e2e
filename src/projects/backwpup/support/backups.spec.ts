import { test, expect } from "@playwright/test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  countBackups,
  listBackups,
  listJobs,
  waitForJobToFinish,
} from "./backups";
import type { LocalTransport } from "../../../common/config/types";

// A stub `wp` on PATH exercises these readers plus the real exec layer, with no WordPress. The
// scenario is chosen per test via $WP_STUB_MODE. Payloads mirror the field names the commands
// document (Backup.php / Job.php at the ref under test), including WP-CLI's habit of emitting
// numeric fields as strings.
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
  not-json)   printf 'Error: Something exploded' ;;
  not-array)  printf '{"name":"x"}' ;;
  count)      printf '4' ;;
  count-bad)  printf 'many' ;;
  fail)       printf 'Error: boom' >&2; exit 1 ;;
  idle)       printf 'Success: No job running.' ;;
  finished)   printf 'Success: Job finished.' ;;
  warnings)   printf 'Warning: Job finished with warnings.' ;;
  errors)     printf 'Error: Job finished with errors!' >&2; exit 1 ;;
  gibberish)  printf 'who knows' ;;
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

test.afterAll(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
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

// `wp backwpup status` blocks until the job ends and then prints one of four verdicts; these cover
// all four, including the error case that exits non-zero and must still be reported rather than
// thrown as an unknown failure.
test.describe("waitForJobToFinish", () => {
  test("no job running", async () => {
    process.env.WP_STUB_MODE = "idle";
    expect(await waitForJobToFinish(local())).toBe("idle");
  });

  test("clean completion", async () => {
    process.env.WP_STUB_MODE = "finished";
    expect(await waitForJobToFinish(local())).toBe("finished");
  });

  test("completion with warnings", async () => {
    process.env.WP_STUB_MODE = "warnings";
    expect(await waitForJobToFinish(local())).toBe("warnings");
  });

  test("completion with errors is reported, not thrown", async () => {
    process.env.WP_STUB_MODE = "errors";
    expect(await waitForJobToFinish(local())).toBe("errors");
  });

  test("an unrecognisable verdict throws with the output attached", async () => {
    process.env.WP_STUB_MODE = "gibberish";
    await expect(waitForJobToFinish(local())).rejects.toThrow(
      /no recognisable verdict/,
    );
  });
});

test.describe("transport plumbing", () => {
  test("uses the transport it is given", async () => {
    process.env.WP_STUB_MODE = "empty";
    expect(await listBackups(transport)).toEqual([]);
  });
});
