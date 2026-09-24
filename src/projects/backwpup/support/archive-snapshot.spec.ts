import { test, expect } from "@playwright/test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ArchiveSnapshot, archiveDigests } from "./archive-snapshot";
import type { HistoryRecord } from "./history";
import type { SiteDirectory } from "../../../common/wp/files";
import type { LocalTransport } from "../../../common/config/types";

const A = "a".repeat(64);
const B = "b".repeat(64);

/** A completed run of job 3 that left `filename`. */
function run(filename: string, jobId = 3): HistoryRecord {
  return {
    filename,
    destination: "FOLDER",
    jobId,
    status: "completed",
    trigger: "wp-cli",
    logfile: `/logs/${filename}.html`,
  };
}

const folder: SiteDirectory = {
  dir: "/site/wp-content/uploads/backwpup/6567c0/backups",
  files: [
    { name: ".htaccess", size: 175, modifiedAt: 1, writable: true, sha256: B },
    { name: "one.tar", size: 5, modifiedAt: 2, writable: true, sha256: A },
    { name: "two.tar", size: 5, modifiedAt: 3, writable: false, sha256: B },
  ],
};

test.describe("archiveDigests", () => {
  test("takes each run's archive digest from the folder", () => {
    expect([
      ...archiveDigests([run("one.tar"), run("two.tar")], folder),
    ]).toEqual([
      ["one.tar", A],
      ["two.tar", B],
    ]);
  });

  // Only what the runs made is recorded; the folder's own guard files are nobody's archive.
  test("records only the archives the history names", () => {
    expect([...archiveDigests([run("two.tar")], folder).keys()]).toEqual([
      "two.tar",
    ]);
  });

  test("refuses a run whose archive is not in the folder, listing what is", () => {
    expect(() => archiveDigests([run("gone.tar")], folder)).toThrow(
      /records "gone\.tar", but .* holds no such file \(it holds: \.htaccess, one\.tar, two\.tar\)/,
    );
  });

  test("refuses a folder read without digests", () => {
    const bare: SiteDirectory = {
      dir: folder.dir,
      files: [{ name: "one.tar", size: 5, modifiedAt: 2, writable: true }],
    };
    expect(() => archiveDigests([run("one.tar")], bare)).toThrow(
      /was read without digests/,
    );
  });
});

// The history, the jobs option and the folder, as a site with one scheduled job and one archive
// answers them — each `wp` call is told apart by what it asks for.
const STUB_WP = `#!/usr/bin/env bash
if [ "$1" = "option" ]; then
  printf '%s' '{"1":{"jobid":1,"tempjob":true,"type":[],"destinations":[]},"3":{"jobid":3,"type":["DBDUMP"],"destinations":["FOLDER"],"activetype":"wpcron"}}'
  exit 0
fi
case "$2" in
  *backup_trigger*) printf '%s' '[{"filename":"one.tar","destination":"FOLDER","job_id":"3","status":"completed","backup_trigger":"wp-cli","logfile":"/logs/one.html"},{"filename":"other.tar","destination":"FOLDER","job_id":"9","status":"completed","backup_trigger":"wp-cli","logfile":"/logs/other.html"},{"filename":"half.tar","destination":"FOLDER","job_id":"3","status":"aborted","backup_trigger":"backup_now_job","logfile":"/logs/half.html"},{"filename":"two.tar","destination":"FOLDER","job_id":"3","status":"completed","backup_trigger":"wp-cli","logfile":"/logs/two.html"}]' ;;
  *backupdir*)
    if [ "$WP_STUB_DELETED" = "1" ]; then
      printf '%s' '{"dir":"/site/backups/","files":[{"name":"two.tar","size":5,"modified":3,"writable":true,"sha256":"${B}"}]}'
    else
      printf '%s' '{"dir":"/site/backups/","files":[{"name":"one.tar","size":5,"modified":2,"writable":true,"sha256":"${A}"},{"name":"two.tar","size":5,"modified":3,"writable":true,"sha256":"${B}"}]}'
    fi ;;
esac
exit 0
`;

let binDir: string;
let originalPath: string | undefined;

test.beforeAll(() => {
  binDir = mkdtempSync(join(tmpdir(), "bwp-snapshot-bin-"));
  writeFileSync(join(binDir, "wp"), STUB_WP);
  chmodSync(join(binDir, "wp"), 0o755);
  originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
});

test.afterAll(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  rmSync(binDir, { recursive: true, force: true });
});

const local = (): LocalTransport => ({ mode: "local", rootDir: binDir });

test.describe("ArchiveSnapshot", () => {
  // Another job's run and an aborted one are in the history too; the snapshot is of the archives the
  // scheduled job's runs actually left.
  test("records the scheduled job's archives as they are on the site", async () => {
    const snapshot = new ArchiveSnapshot();
    await snapshot.record(local());
    expect(snapshot.digestOf("one.tar")).toBe(A);
    expect(snapshot.digestOf("two.tar")).toBe(B);
    expect(() => snapshot.digestOf("other.tar")).toThrow(/never recorded/);
    expect(() => snapshot.digestOf("half.tar")).toThrow(/never recorded/);
  });

  test("refuses to compare against an archive it never recorded", () => {
    expect(() => new ArchiveSnapshot().digestOf("one.tar")).toThrow(
      /"one\.tar" was never recorded/,
    );
  });

  test("names the oldest and newest archive by the order the runs made them in", async () => {
    const snapshot = new ArchiveSnapshot();
    await snapshot.record(local());
    expect(snapshot.named("oldest")).toBe("one.tar");
    expect(snapshot.named("newest")).toBe("two.tar");
  });

  // The history still records an archive the scenario deleted since — which recording again must
  // neither trip over nor forget, or "the oldest backup" would move.
  test("records again after one of its archives was deleted, keeping what it holds", async () => {
    const snapshot = new ArchiveSnapshot();
    await snapshot.record(local());
    process.env.WP_STUB_DELETED = "1";
    try {
      await snapshot.record(local());
    } finally {
      delete process.env.WP_STUB_DELETED;
    }
    expect([snapshot.named("oldest"), snapshot.named("newest")]).toEqual([
      "one.tar",
      "two.tar",
    ]);
    expect(snapshot.digestOf("one.tar")).toBe(A);
  });

  test("refuses to name an archive when none was recorded", () => {
    expect(() => new ArchiveSnapshot().named("newest")).toThrow(
      /no backup was recorded, so there is no newest one/,
    );
  });
});
