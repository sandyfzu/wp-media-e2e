import { test, expect } from "@playwright/test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HISTORY_PHP, parseHistory, readHistory } from "./history";
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
      },
    ]);
  });

  test("reads an empty table as no history", () => {
    expect(parseHistory("[]")).toEqual([]);
  });

  // The two columns the schema lets be NULL.
  test("reads a NULL filename as empty and a NULL job as absent", () => {
    const [row] = parseHistory(
      JSON.stringify([
        {
          filename: null,
          destination: "FOLDER",
          job_id: null,
          status: "failed",
          backup_trigger: "",
        },
      ]),
    );
    expect(row?.filename).toBe("");
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
  });

  // Each of these would otherwise have to be read as "no backups", which passes absence checks.
  test("refuses output that is not a JSON list of rows", () => {
    expect(() => parseHistory("")).toThrow(/did not come back as JSON/);
    expect(() => parseHistory("false")).toThrow(/expected a list of rows/);
    expect(() => parseHistory("[1]")).toThrow(/expected a row/);
  });
});

test.describe("HISTORY_PHP", () => {
  test("reads the plugin's table under the site's own prefix", () => {
    const [encoded] = [
      ...HISTORY_PHP.matchAll(/base64_decode\( '([^']+)' \)/g),
    ].map((match) => match[1] ?? "");
    expect(
      JSON.parse(Buffer.from(encoded ?? "", "base64").toString()) as unknown,
    ).toBe("bwpup_backups");
    expect(HISTORY_PHP).toContain("$wpdb->prefix");
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
