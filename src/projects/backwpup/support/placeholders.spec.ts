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

import { ArchiveSnapshot } from "./archive-snapshot";
import { fillPlaceholders } from "./cli-session";
import { ScenarioKeys } from "./encryption-keys";
import { PrivateFolder } from "./private-folder";
import { commandArgv, commandPlaceholders } from "./placeholders";
import type { LocalTransport } from "../../../common/config/types";

// Two completed runs, then an aborted one, as the history records them. The aborted run names the
// archive it was writing, which it never finished — no backup, but a log, and the newest one.
const HISTORY = JSON.stringify([
  {
    filename: "first.tar",
    destination: "FOLDER",
    job_id: "3",
    status: "completed",
    backup_trigger: "wp-cli",
    logfile: "/site/logs/backwpup_log_aaaaaa_first.html",
  },
  {
    filename: "last.tar",
    destination: "FOLDER",
    job_id: "3",
    status: "completed",
    backup_trigger: "wp-cli",
    logfile: "/site/logs/backwpup_log_bbbbbb_last.html",
  },
  {
    filename: "aborted.tar",
    destination: "FOLDER",
    job_id: "3",
    status: "aborted",
    backup_trigger: "backup_now_job",
    logfile: "/site/logs/backwpup_log_cccccc_aborted.html",
  },
]);

/** The job's backup folder, holding the two completed runs' archives. */
const FOLDER = JSON.stringify({
  dir: "/site/backups/",
  files: ["first.tar", "last.tar"].map((name) => ({
    name,
    size: 5,
    modified: 1,
    writable: true,
    sha256: "a".repeat(64),
  })),
});

/**
 * A stub `wp` answering the jobs option, the history, an archive's location, the backup folder, the
 * private folder's preparation, a file placed in it and the marker path — counting every call.
 */
const STUB_WP = `#!/usr/bin/env bash
printf 'x\\n' >> "$WP_STUB_CALLS"
printf '%s' "$2" > "$WP_STUB_CALLS.last"
if [ "$1" = "option" ]; then
  printf '%s' '{"1":{"jobid":1,"tempjob":true,"type":[],"destinations":[]},"3":{"jobid":3,"type":["DBDUMP"],"destinations":["FOLDER"],"activetype":"wpcron"}}'
  exit 0
fi
case "$2" in
  *backup_trigger*)  printf '%s' '${HISTORY}' ;;
  *"'path' => realpath( \\$path )"*) printf '{"path":"%s/wp-content/uploads/backwpup/x/backups/last.tar","cwd":"%s"}' "$WP_STUB_ROOT" "$WP_STUB_ROOT" ;;
  *backupdir*)       printf '%s' '${FOLDER}' ;;
  *"mkdir( \\$dir, 0700 )"*) printf '{"mode":"700","path":"%s/.e2e_temp/private/abc-r0","cwd":"%s"}' "$WP_STUB_ROOT" "$WP_STUB_ROOT" ;;
  *"file_put_contents( \\$path, \\$content )"*) printf 'placed' ;;
  *"str_repeat( '../'"*) printf '../../../../../site/wp-content/e2e-backup-marker.txt' ;;
esac
exit 0
`;

let binDir: string;
let rootDir: string;
let calls: string;
let originalPath: string | undefined;

test.beforeAll(() => {
  binDir = mkdtempSync(join(tmpdir(), "bwp-placeholders-bin-"));
  rootDir = mkdtempSync(join(tmpdir(), "bwp-placeholders-root-"));
  calls = join(binDir, "calls");
  writeFileSync(join(binDir, "wp"), STUB_WP);
  chmodSync(join(binDir, "wp"), 0o755);
  originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
  process.env.WP_STUB_CALLS = calls;
  process.env.WP_STUB_ROOT = rootDir;
});

test.beforeEach(() => {
  rmSync(calls, { force: true });
});

test.afterAll(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  delete process.env.WP_STUB_CALLS;
  delete process.env.WP_STUB_ROOT;
  rmSync(binDir, { recursive: true, force: true });
  rmSync(rootDir, { recursive: true, force: true });
});

const local = (): LocalTransport => ({ mode: "local", rootDir });

/** The scope the generic step hands over, for one scenario. */
function scopeOf(archives = new ArchiveSnapshot()) {
  const transport = local();
  const privateFolder = new PrivateFolder(transport, "abc-r0");
  return {
    transport,
    privateFolder,
    archives,
    keys: new ScenarioKeys(privateFolder),
  };
}

/** Fills one command the way the generic step does, with `archives` as the scenario recorded them. */
function fill(
  text: string,
  scope: ReturnType<typeof scopeOf> = scopeOf(),
): Promise<string> {
  return fillPlaceholders(text, commandPlaceholders(scope));
}

/** The values the last snippet embedded, decoded the way PHP will decode them. */
const namesSent = (): unknown[] =>
  [
    ...readFileSync(`${calls}.last`, "utf8").matchAll(
      /base64_decode\( '([^']+)' \)/g,
    ),
  ].map(
    (match) =>
      JSON.parse(Buffer.from(match[1] ?? "", "base64").toString()) as unknown,
  );

/** How many times the site was asked anything. */
const asked = (): number =>
  existsSync(calls) ? readFileSync(calls, "utf8").split("\n").length - 1 : 0;

test.describe("commandPlaceholders", () => {
  test("names the scheduled job by its stored id, never BackWPup's hidden placeholder job", async () => {
    expect(await fill("run {job} --background")).toBe("run 3 --background");
  });

  // As the scenario recorded them, in the history's order and only runs that left an archive: the
  // aborted run is the newest row, but it is no backup.
  test("names the oldest and newest backup the scenario made", async () => {
    const archives = new ArchiveSnapshot();
    await archives.record(local());
    const scope = scopeOf(archives);
    expect(await fill("backup-delete {oldest backup} --yes", scope)).toBe(
      "backup-delete first.tar --yes",
    );
    expect(await fill("backup-delete {newest backup} --yes", scope)).toBe(
      "backup-delete last.tar --yes",
    );
  });

  // The encryption commands take a path, which the site works out for the archive it holds — the
  // one asked for, by name.
  test("names the newest backup as a path from where WP-CLI runs", async () => {
    const archives = new ArchiveSnapshot();
    await archives.record(local());
    expect(
      await fill(
        "backup-encrypt {path to the newest backup}",
        scopeOf(archives),
      ),
    ).toBe("backup-encrypt wp-content/uploads/backwpup/x/backups/last.tar");
    expect(namesSent()).toContain("last.tar");
    await fill("backup-encrypt {path to the oldest backup}", scopeOf(archives));
    expect(namesSent()).toContain("first.tar");
  });

  test("refuses a path to a backup the scenario never made", async () => {
    await expect(
      fill("backup-encrypt {path to the oldest backup}"),
    ).rejects.toThrow(/no backup was recorded/);
  });

  // Drawn for the scenario, the same wherever it is named again, and never the same as the other.
  test("names the scenario's two hex keys, each the same every time it is named", async () => {
    const scope = scopeOf();
    const first = await fill(
      "backup-encrypt a.tar --key={encryption key}",
      scope,
    );
    expect(first).toMatch(/^backup-encrypt a\.tar --key=[0-9a-f]{64}$/);
    expect(
      await fill("backup-decrypt a.tar --key={encryption key}", scope),
    ).toBe(first.replace("backup-encrypt", "backup-decrypt"));
    expect(
      await fill("backup-decrypt a.tar --key={another encryption key}", scope),
    ).not.toBe(first.replace("backup-encrypt", "backup-decrypt"));
  });

  test("names the key pair's files inside the scenario's private folder", async () => {
    expect(
      await fill(
        "backup-encrypt a.tar --key={public key file} {private key file}",
        scopeOf(),
      ),
    ).toBe(
      "backup-encrypt a.tar --key=.e2e_temp/private/abc-r0/scenario-public.pem .e2e_temp/private/abc-r0/scenario-private.pem",
    );
  });

  test("refuses to name a backup the scenario never made", async () => {
    await expect(fill("backup-delete {newest backup} --yes")).rejects.toThrow(
      /no backup was recorded/,
    );
  });

  // Every run writes a log, however it ended — so the aborted run's is the newest.
  test("names the oldest and newest run's log by the file the log commands take", async () => {
    expect(await fill("log-show {oldest log}")).toBe(
      "log-show backwpup_log_aaaaaa_first.html",
    );
    expect(await fill("log-show {newest log}")).toBe(
      "log-show backwpup_log_cccccc_aborted.html",
    );
  });

  test("names the private folder relative to the directory WP-CLI runs in", async () => {
    expect(await fill("backup-download x.tar {private folder}/")).toBe(
      "backup-download x.tar .e2e_temp/private/abc-r0/",
    );
  });

  test("names the proved path out of the log folder", async () => {
    expect(
      await fill("log-show {path from the log folder to the marker file}"),
    ).toBe("log-show ../../../../../site/wp-content/e2e-backup-marker.txt");
  });

  // The generic step fills every command, so a command naming nothing must cost nothing.
  test("asks the site nothing for a command that names no placeholder", async () => {
    expect(await fill("backup --format=count")).toBe("backup --format=count");
    expect(asked()).toBe(0);
  });
});

test.describe("commandArgv", () => {
  const scope = () => scopeOf();

  test("fills a command's placeholders, then splits it into its arguments", async () => {
    expect(await commandArgv("run {job} --background", scope())).toEqual([
      "run",
      "3",
      "--background",
    ]);
  });

  // Judged as written, so a slip reaches neither the site nor the plugin.
  test("refuses a written path off the site before asking the site anything", async () => {
    await expect(
      commandArgv("backup-download x.tar /var/www/other/x.tar --yes", scope()),
    ).rejects.toThrow(/a path that leads off the site/);
    expect(asked()).toBe(0);
  });
});
