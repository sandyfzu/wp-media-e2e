import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SNAPSHOTS_PHP,
  isSnapshotPath,
  parseSnapshots,
  removeSnapshot,
  snapshotHolds,
} from "./restore-snapshots";
import { FILE_MARKER_NAME } from "./markers";
import type { LocalTransport } from "../../../common/config/types";

/**
 * The `--pre-backup` snapshots: how they are listed, told apart, read and removed. Reading and
 * removing run over the `local` transport against real directories.
 */

const HAS_PHP = spawnSync("php", ["-v"]).status === 0;

test.describe("parseSnapshots", () => {
  test("reads the listing", () => {
    expect(
      parseSnapshots(
        '{"dir":"/tmp/","snapshots":["/tmp/backwpup-snapshot-6ac41.559"]}',
      ),
    ).toEqual({
      dir: "/tmp/",
      snapshots: ["/tmp/backwpup-snapshot-6ac41.559"],
    });
  });

  for (const reply of ["", "{}", '{"dir":"/tmp/","snapshots":[1]}']) {
    test(`refuses ${JSON.stringify(reply)}`, () => {
      expect(() => parseSnapshots(reply)).toThrow(/unexpected answer/);
    });
  }
});

// The last check before an `rm -rf`: the measured name, and nothing that leads anywhere else.
test.describe("isSnapshotPath", () => {
  test("recognises only a snapshot directory directly in the temp directory", () => {
    expect(
      isSnapshotPath("/tmp/backwpup-snapshot-6ac4143fe8c876.55994123", "/tmp/"),
    ).toBe(true);
    expect(isSnapshotPath("/tmp/backwpup-snapshot-6ac41.5", "/tmp")).toBe(true);
    for (const path of [
      "/tmp/backwpup-snapshot-",
      "/tmp/backwpup-snapshot-x.1",
      "/tmp/backwpup-snapshot-6ac4/../../etc",
      "/tmp/sub/backwpup-snapshot-6ac41.5",
      "/var/tmp/backwpup-snapshot-6ac41.5",
      "/tmp/backwpup-restore-6ac41.5",
    ]) {
      expect(isSnapshotPath(path, "/tmp/"), path).toBe(false);
    }
  });
});

test.describe("SNAPSHOTS_PHP", () => {
  test.skip(!HAS_PHP, "no php binary on this machine");

  test("parses as PHP", () => {
    const result = spawnSync("php", ["-l"], {
      input: `<?php\n${SNAPSHOTS_PHP}`,
      encoding: "utf8",
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  test("lists snapshot directories, never a link or a file", () => {
    const dir = mkdtempSync(join(tmpdir(), "bwp-snapshots-"));
    try {
      mkdirSync(join(dir, "backwpup-snapshot-aa.1"));
      writeFileSync(join(dir, "backwpup-snapshot-bb.2"), "a file");
      symlinkSync(
        join(dir, "backwpup-snapshot-aa.1"),
        join(dir, "backwpup-snapshot-cc.3"),
      );
      mkdirSync(join(dir, "backwpup-restore-dd.4"));
      const snippet = join(dir, "s.php");
      writeFileSync(snippet, SNAPSHOTS_PHP);
      const harness = join(dir, "h.php");
      writeFileSync(
        harness,
        `<?php
function get_temp_dir() { return ${JSON.stringify(dir)}; }
function trailingslashit( $s ) { return rtrim( $s, '/' ) . '/'; }
function wp_json_encode( $v ) { return json_encode( $v, JSON_UNESCAPED_SLASHES ); }
eval( file_get_contents( $argv[1] ) );`,
      );
      const result = spawnSync("php", [harness, snippet], { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      expect(parseSnapshots(result.stdout)).toEqual({
        dir: `${dir}/`,
        snapshots: [join(dir, "backwpup-snapshot-aa.1")],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test.describe("reading and removing a snapshot", () => {
  let temp: string;
  let snapshot: string;
  const local = (): LocalTransport => ({ mode: "local", rootDir: temp });
  const MARKERS = { file: "f1le-marker", database: "db-marker-42" };

  test.beforeEach(() => {
    temp = mkdtempSync(join(tmpdir(), "bwp-snapshot-tmp-"));
    snapshot = join(temp, "backwpup-snapshot-6ac41.559");
    mkdirSync(join(snapshot, "wp-content"), { recursive: true });
  });

  test.afterEach(() => {
    rmSync(temp, { recursive: true, force: true });
  });

  test("says which markers it holds: the file in its wp-content, the database in its export", async () => {
    writeFileSync(join(snapshot, "wp-content", FILE_MARKER_NAME), MARKERS.file);
    writeFileSync(
      join(snapshot, "db.sql"),
      `INSERT INTO wp_options VALUES ('e2e_backup_marker','${MARKERS.database}');\n`,
    );
    expect(await snapshotHolds(local(), snapshot, MARKERS)).toEqual({
      file: true,
      database: true,
    });
    expect(
      await snapshotHolds(local(), snapshot, {
        file: "other",
        database: "other",
      }),
    ).toEqual({ file: false, database: false });
  });

  // The command writes its export first, so one cut short holds only that.
  test("reads a snapshot cut short after its export", async () => {
    rmSync(join(snapshot, "wp-content"), { recursive: true });
    writeFileSync(join(snapshot, "db.sql"), MARKERS.database);
    expect(await snapshotHolds(local(), snapshot, MARKERS)).toEqual({
      file: false,
      database: true,
    });
  });

  test("removes a snapshot directory, and confirms it gone", async () => {
    writeFileSync(join(snapshot, "db.sql"), "x");
    await removeSnapshot(local(), snapshot, `${temp}/`);
    expect(existsSync(snapshot)).toBe(false);
  });

  test("refuses anything that is not a snapshot directory in the temp directory", async () => {
    const other = join(temp, "keep");
    mkdirSync(other);
    await removeSnapshot(local(), other, temp);
    await removeSnapshot(local(), snapshot, join(temp, "elsewhere"));
    expect(existsSync(other)).toBe(true);
    expect(existsSync(snapshot)).toBe(true);
  });
});
