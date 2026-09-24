import { test, expect } from "@playwright/test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  HISTORY_PHP,
  HISTORY_ROWS_PHP,
  archivedRuns,
  historyRecords,
  logName,
  loggedRuns,
  parseHistory,
  pickRun,
  readHistory,
  runOrder,
} from "./history";
import type { HistoryRecord } from "./history";
import type { LocalTransport } from "../../../common/config/types";

// What the snippet printed on a live cell after one `run --background`, verbatim. `$wpdb` hands every
// column over as a string, numbers included.
const LIVE = JSON.stringify([
  {
    filename: "2026-09-22_12-51-15_6SWJKUSM03_DBDUMP.tar",
    destination: "FOLDER",
    job_id: "3",
    status: "completed",
    backup_trigger: "backup_now_job",
    logfile:
      "/var/www/html/site/wp-content/uploads/backwpup/6567c0/logs/backwpup_log_6a5677_2026-09-22_12-51-15.html",
  },
]);

// The same house pattern as the other support specs: a stub `wp` on PATH exercises the reader over
// the real exec layer, with no WordPress.
const STUB_WP = `#!/usr/bin/env bash
case "$WP_STUB_MODE" in
  live)    printf '%s' '${LIVE}' ;;
  missing) printf "Error: reading wp_bwpup_backups failed: Table 'wp_bwpup_backups' doesn't exist\\n" >&2; exit 1 ;;
esac
exit 0
`;

let binDir: string;
let rootDir: string;
let originalPath: string | undefined;

test.beforeAll(() => {
  binDir = mkdtempSync(join(tmpdir(), "bwp-history-bin-"));
  rootDir = mkdtempSync(join(tmpdir(), "bwp-history-root-"));
  const wp = join(binDir, "wp");
  writeFileSync(wp, STUB_WP);
  chmodSync(wp, 0o755);
  originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
});

test.afterAll(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  delete process.env.WP_STUB_MODE;
  rmSync(binDir, { recursive: true, force: true });
  rmSync(rootDir, { recursive: true, force: true });
});

const local = (): LocalTransport => ({ mode: "local", rootDir });

/** A row as the table produces it, with one column replaced. */
const rowWith = (column: string, value: unknown): string =>
  JSON.stringify([{ ...(JSON.parse(LIVE) as object[])[0], [column]: value }]);

test.describe("parseHistory", () => {
  test("maps a row the table produced on a live cell", () => {
    expect(parseHistory(LIVE)).toEqual([
      {
        filename: "2026-09-22_12-51-15_6SWJKUSM03_DBDUMP.tar",
        destination: "FOLDER",
        jobId: 3,
        status: "completed",
        trigger: "backup_now_job",
        logfile:
          "/var/www/html/site/wp-content/uploads/backwpup/6567c0/logs/backwpup_log_6a5677_2026-09-22_12-51-15.html",
      },
    ]);
  });

  test("reads an empty table as no history", () => {
    expect(parseHistory("[]")).toEqual([]);
  });

  // The three columns the schema lets be NULL.
  test("reads a NULL filename or log as empty and a NULL job as absent", () => {
    const [row] = parseHistory(
      JSON.stringify([
        {
          filename: null,
          destination: "FOLDER",
          job_id: null,
          status: "failed",
          backup_trigger: "",
          logfile: null,
        },
      ]),
    );
    expect(row?.filename).toBe("");
    expect(row?.logfile).toBe("");
    expect(row).not.toHaveProperty("jobId");
  });

  // A driver configured for native types returns the same value unquoted.
  test("accepts a job id handed over as a number", () => {
    expect(parseHistory(rowWith("job_id", 3))[0]?.jobId).toBe(3);
  });

  test("refuses a job id that is not an integer", () => {
    expect(() => parseHistory(rowWith("job_id", "3.5"))).toThrow(
      /expected "job_id" to be an integer/,
    );
    expect(() => parseHistory(rowWith("job_id", ""))).toThrow(
      /expected "job_id" to be an integer/,
    );
  });

  // A column the query selected but did not get back means the query or the schema changed.
  test("refuses a row missing a column it should carry", () => {
    expect(() => parseHistory(rowWith("status", undefined))).toThrow(
      /expected "status" to be text/,
    );
    expect(() => parseHistory(rowWith("logfile", undefined))).toThrow(
      /expected "logfile" to be text/,
    );
  });

  // Each of these would otherwise have to be read as "no backups", which passes absence checks.
  test("refuses output that is not a JSON list of rows", () => {
    expect(() => parseHistory("")).toThrow(/did not come back as JSON/);
    expect(() => parseHistory("false")).toThrow(/expected a list of rows/);
    expect(() => parseHistory("[1]")).toThrow(/expected a row/);
  });
});

test.describe("historyRecords", () => {
  // What a snippet reporting the rows beside something else hands over, once decoded.
  test("maps rows that were decoded elsewhere", () => {
    expect(historyRecords(JSON.parse(LIVE))).toEqual(parseHistory(LIVE));
  });

  test("refuses anything that is not a list of rows", () => {
    expect(() => historyRecords(undefined)).toThrow(/expected a list of rows/);
    expect(() => historyRecords({})).toThrow(/expected a list of rows/);
  });
});

test.describe("HISTORY_PHP", () => {
  // One query, shared: the snippet that prints the rows is the one that reads them, plus the echo.
  test("prints exactly the rows the shared query reads", () => {
    expect(HISTORY_PHP.startsWith(HISTORY_ROWS_PHP)).toBe(true);
    expect(HISTORY_PHP.slice(HISTORY_ROWS_PHP.length).trim()).toBe(
      "echo wp_json_encode( $rows );",
    );
  });

  test("reads the plugin's table under the site's own prefix", () => {
    const [encoded] = [
      ...HISTORY_PHP.matchAll(/base64_decode\( '([^']+)' \)/g),
    ].map((match) => match[1] ?? "");
    expect(
      JSON.parse(Buffer.from(encoded ?? "", "base64").toString()) as unknown,
    ).toBe("bwpup_backups");
    expect(HISTORY_PHP).toContain("$wpdb->prefix");
  });

  // The log is what ties a run to the log commands' file names, so the query must ask for it.
  test("reads each run's log alongside its archive", () => {
    expect(HISTORY_ROWS_PHP).toMatch(/SELECT [^"]*\blogfile\b[^"]* FROM/);
  });

  // `$wpdb` answers a missing table with an empty result; only `last_error` says otherwise.
  test("turns a failed query into an error rather than an empty list", () => {
    expect(HISTORY_PHP).toContain("$wpdb->last_error");
    expect(HISTORY_PHP).toContain("WP_CLI::error");
  });
});

test.describe("readHistory", () => {
  test("asks the site and parses what it answers", async () => {
    process.env.WP_STUB_MODE = "live";
    expect(await readHistory(local())).toHaveLength(1);
  });

  test("reports a table it could not read, rather than an empty history", async () => {
    process.env.WP_STUB_MODE = "missing";
    await expect(readHistory(local())).rejects.toThrow(/doesn't exist/);
  });
});

/** A run as {@link parseHistory} maps it, with the fields a case cares about replaced. */
function run(overrides: Partial<HistoryRecord>): HistoryRecord {
  return {
    filename: "2026-09-23_11-32-52_QNSWPQFL03_DBDUMP.tar",
    destination: "FOLDER",
    jobId: 3,
    status: "completed",
    trigger: "wp-cli",
    logfile:
      "/site/wp-content/uploads/backwpup/6567c0/logs/backwpup_log_8cbb38_2026-09-23_11-32-52.html",
    ...overrides,
  };
}

test.describe("naming one run", () => {
  const first = run({ filename: "first.tar", logfile: "/logs/first.html" });
  const aborted = run({
    filename: "aborted.tar",
    status: "aborted",
    logfile: "/logs/aborted.html",
  });
  const last = run({ filename: "last.tar", logfile: "/logs/last.html" });

  test("reads only oldest or newest as an order", () => {
    expect(runOrder("oldest")).toBe("oldest");
    expect(runOrder("newest")).toBe("newest");
    expect(() => runOrder("latest")).toThrow(/write "oldest" or "newest"/);
  });

  // An aborted run is recorded under the archive it was writing, which it never finished.
  test("counts as archived only the runs that completed and name an archive", () => {
    expect(
      archivedRuns([
        first,
        aborted,
        run({ filename: "", status: "completed" }),
        last,
      ]),
    ).toEqual([first, last]);
  });

  test("counts every run that names a log, however it ended", () => {
    expect(loggedRuns([first, aborted, run({ logfile: "" }), last])).toEqual([
      first,
      aborted,
      last,
    ]);
  });

  test("picks either end of the history, in the order it was recorded", () => {
    expect(pickRun([first, last], "oldest", "run")).toBe(first);
    expect(pickRun([first, last], "newest", "run")).toBe(last);
    expect(pickRun([first], "newest", "run")).toBe(first);
  });

  test("refuses to pick from no runs, naming what was sought", () => {
    expect(() => pickRun([], "newest", "run that left an archive")).toThrow(
      "records no run that left an archive, so there is no newest one",
    );
  });

  test("names a run's log by the file the log commands take", () => {
    expect(logName(run({}))).toBe(
      "backwpup_log_8cbb38_2026-09-23_11-32-52.html",
    );
  });
});
