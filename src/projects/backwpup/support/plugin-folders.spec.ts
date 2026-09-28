import { test, expect } from "@playwright/test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  backupArchivePhp,
  backupPathFromWorkingDir,
  isLogFile,
  makeLogReadOnly,
  markerPathFromLogFolder,
  readBackupFolder,
  readLogFolder,
} from "./plugin-folders";
import { FILE_LIST_PHP } from "../../../common/wp/files";
import type { LocalTransport } from "../../../common/config/types";

// The folders as a live cell reported them after two runs — trimmed, and with the log folder's own
// guards left in, which is what the log reader must leave out.
const LOGS = JSON.stringify({
  dir: "/var/www/html/site/wp-content/uploads/backwpup/6567c0/logs/",
  files: [
    { name: ".htaccess", size: 175, modified: 1790181172, writable: true },
    {
      name: "backwpup_log_6a5677_2026-09-23_11-32-54.html",
      size: 3177,
      modified: 1790181175,
      writable: true,
    },
    {
      name: "backwpup_log_8cbb38_2026-09-23_11-32-52.html",
      size: 3177,
      modified: 1790181173,
      writable: true,
    },
    { name: "index.php", size: 99, modified: 1790181172, writable: true },
  ],
});
const BACKUPS = JSON.stringify({
  dir: "/var/www/html/site/wp-content/uploads/backwpup/6567c0/backups/",
  files: [
    {
      name: "2026-09-23_11-32-54_MFSWPQBC03_DBDUMP.tar",
      size: 42230272,
      modified: 1790181175,
      writable: false,
      sha256:
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    },
  ],
});

/** A stub `wp` on PATH, recording the snippet it was handed so its guards can be pinned. */
const STUB_WP = `#!/usr/bin/env bash
printf '%s' "$2" > "$WP_STUB_CAPTURE"
case "$WP_STUB_MODE" in
  logs)       printf '%s' '${LOGS}' ;;
  backups)    printf '%s' '${BACKUPS}' ;;
  no-dir)     printf '{"files":[]}' ;;
  not-loaded) printf 'Error: BackWPup is not loaded, so where it keeps its files cannot be read' >&2; exit 1 ;;
  read-only)  printf 'read-only' ;;
  chatty)     printf 'Notice: x\\nread-only' ;;
  refused)    printf 'Error: could not make /logs/a.html read-only (only its owner may): chmod(): Operation not permitted' >&2; exit 1 ;;
  path)       printf '../../../../../../var/www/html/site/wp-content/e2e-backup-marker.txt' ;;
  inward)     printf 'e2e-backup-marker.txt' ;;
  elsewhere)  printf '../../../../../../etc/passwd' ;;
  no-marker)  printf 'Error: the marker file is not on the site, so there is nothing to lead to — plant it first' >&2; exit 1 ;;
  located)    printf '%s' '{"path":"/var/www/html/site/wp-content/uploads/backwpup/6567c0/backups/a.tar","cwd":"/var/www/html/site"}' ;;
  no-archive) printf 'Error: no archive a.tar in /var/www/html/site/wp-content/uploads/backwpup/6567c0/backups/' >&2; exit 1 ;;
esac
exit 0
`;

let binDir: string;
let rootDir: string;
let capture: string;
let originalPath: string | undefined;

test.beforeAll(() => {
  binDir = mkdtempSync(join(tmpdir(), "bwp-folders-bin-"));
  rootDir = mkdtempSync(join(tmpdir(), "bwp-folders-root-"));
  capture = join(binDir, "captured-php.txt");
  const wp = join(binDir, "wp");
  writeFileSync(wp, STUB_WP);
  chmodSync(wp, 0o755);
  originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
  process.env.WP_STUB_CAPTURE = capture;
});

test.afterAll(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  delete process.env.WP_STUB_CAPTURE;
  delete process.env.WP_STUB_MODE;
  rmSync(binDir, { recursive: true, force: true });
  rmSync(rootDir, { recursive: true, force: true });
});

const local = (): LocalTransport => ({ mode: "local", rootDir });
const captured = (): string => readFileSync(capture, "utf8");

test.describe("isLogFile", () => {
  for (const name of [
    "backwpup_log_8cbb38_2026-09-23_11-32-52.html",
    "backwpup_log_8cbb38_2026-09-23_11-32-52.html.gz",
  ]) {
    test(`recognises ${name} as a run's log`, () => {
      expect(isLogFile(name)).toBe(true);
    });
  }

  // The folder's own guards, and names that merely look like a log.
  for (const name of [
    "index.php",
    ".htaccess",
    "backwpup_log_8cbb38.txt",
    "backwpup_log_.html",
    "old-backwpup_log_8cbb38.html",
  ]) {
    test(`does not count ${name} as a log`, () => {
      expect(isLogFile(name)).toBe(false);
    });
  }
});

test.describe("readLogFolder", () => {
  test("lists the run logs and leaves the folder's own guards out", async () => {
    process.env.WP_STUB_MODE = "logs";
    const folder = await readLogFolder(local());
    expect(folder.dir).toBe(
      "/var/www/html/site/wp-content/uploads/backwpup/6567c0/logs",
    );
    expect(folder.files.map((file) => file.name)).toEqual([
      "backwpup_log_6a5677_2026-09-23_11-32-54.html",
      "backwpup_log_8cbb38_2026-09-23_11-32-52.html",
    ]);
  });

  // The location is the plugin's setting; the listing is PHP's own, not the plugin's.
  test("takes the folder from the plugin's setting and lists it independently", async () => {
    process.env.WP_STUB_MODE = "logs";
    await readLogFolder(local());
    expect(captured()).toContain("get_site_option( 'backwpup_cfg_logfolder' )");
    expect(captured()).toContain(FILE_LIST_PHP);
  });

  test("refuses to guess when BackWPup is not loaded", async () => {
    process.env.WP_STUB_MODE = "not-loaded";
    await expect(readLogFolder(local())).rejects.toThrow(/is not loaded/);
    expect(captured()).toContain("class_exists( 'BackWPup_File' )");
  });

  test("refuses a reply that does not say which folder it read", async () => {
    process.env.WP_STUB_MODE = "no-dir";
    await expect(readLogFolder(local())).rejects.toThrow(
      /listing the log folder came back as .*, not a directory and its files/,
    );
  });
});

test.describe("readBackupFolder", () => {
  test("reads the job's own backup folder, with digests when asked", async () => {
    process.env.WP_STUB_MODE = "backups";
    const folder = await readBackupFolder(local(), 3, { digests: true });
    expect(folder.dir).toBe(
      "/var/www/html/site/wp-content/uploads/backwpup/6567c0/backups",
    );
    expect(folder.files).toEqual([
      {
        name: "2026-09-23_11-32-54_MFSWPQBC03_DBDUMP.tar",
        size: 42230272,
        modifiedAt: 1790181175,
        writable: false,
        sha256:
          "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      },
    ]);
    // The id and the flag both travel as literals.
    expect(captured()).toContain(
      "BackWPup_Option::get( json_decode( base64_decode( 'Mw==' ), true ), 'backupdir' )",
    );
    expect(captured()).toContain(
      "$digests = json_decode( base64_decode( 'dHJ1ZQ==' ), true );",
    );
  });

  // Asked for digests, a reply without them is refused rather than read as unhashed files.
  test("refuses entries without a digest when digests were asked for", async () => {
    process.env.WP_STUB_MODE = "logs";
    await expect(
      readBackupFolder(local(), 3, { digests: true }),
    ).rejects.toThrow(/expected "sha256"/);
  });
});

test.describe("backupArchivePhp", () => {
  test("points at the archive inside the job's own backup folder, and stops when it is not there", () => {
    const php = backupArchivePhp(3, "a.tar");
    expect(php).toContain(
      "$dir = BackWPup_File::get_absolute_path( BackWPup_Option::get( json_decode( base64_decode( 'Mw==' ), true ), 'backupdir' ) );",
    );
    expect(php).toContain(
      "$path = rtrim( $dir, '/' ) . '/' . json_decode( base64_decode( 'ImEudGFyIg==' ), true );",
    );
    expect(php).toContain(
      "if ( ! is_file( $path ) ) {\n\tWP_CLI::error( 'no archive ' . basename( $path ) . ' in ' . $dir );\n}",
    );
  });

  // The name is joined onto the folder; anything but one segment would lead out of it.
  for (const name of ["", "..", "../wp-config.php", "a/b.tar", "a\\b.tar"]) {
    test(`refuses a name that is not one segment (${JSON.stringify(name)})`, () => {
      expect(() => backupArchivePhp(3, name)).toThrow(
        /is not an archive's name/,
      );
    });
  }
});

test.describe("backupPathFromWorkingDir", () => {
  test("hands the archive out relative to where WP-CLI runs, as the site located both", async () => {
    process.env.WP_STUB_MODE = "located";
    expect(await backupPathFromWorkingDir(local(), 3, "a.tar")).toBe(
      "wp-content/uploads/backwpup/6567c0/backups/a.tar",
    );
    expect(captured()).toContain("BackWPup_Option::get(");
  });

  test("passes on the site's answer that the folder holds no such archive", async () => {
    process.env.WP_STUB_MODE = "no-archive";
    await expect(backupPathFromWorkingDir(local(), 3, "a.tar")).rejects.toThrow(
      /no archive a.tar in/,
    );
  });
});

test.describe("makeLogReadOnly", () => {
  test("succeeds only on the snippet's own confirmation", async () => {
    process.env.WP_STUB_MODE = "read-only";
    await makeLogReadOnly(local(), "backwpup_log_8cbb38.html");

    process.env.WP_STUB_MODE = "chatty";
    await expect(
      makeLogReadOnly(local(), "backwpup_log_8cbb38.html"),
    ).rejects.toThrow(/answered/);
  });

  // The name is kept to the log folder, and the result is checked the way the plugin checks it.
  test("stays in the log folder and re-checks writability afterwards", async () => {
    process.env.WP_STUB_MODE = "read-only";
    await makeLogReadOnly(local(), "backwpup_log_8cbb38.html");
    const php = captured();
    expect(php).toContain("basename( $name )");
    expect(php).toContain("fileperms( $path ) & 0555");
    const cleared = php.indexOf("clearstatcache( true, $path )");
    expect(cleared).toBeGreaterThan(-1);
    expect(cleared).toBeLessThan(php.indexOf("if ( is_writable( $path ) )"));
  });

  test("passes on the site's refusal", async () => {
    process.env.WP_STUB_MODE = "refused";
    await expect(
      makeLogReadOnly(local(), "backwpup_log_8cbb38.html"),
    ).rejects.toThrow(/only its owner may/);
  });
});

test.describe("markerPathFromLogFolder", () => {
  test("returns the path the site proved leads to the marker", async () => {
    process.env.WP_STUB_MODE = "path";
    expect(await markerPathFromLogFolder(local())).toBe(
      "../../../../../../var/www/html/site/wp-content/e2e-backup-marker.txt",
    );
  });

  // Each check is what keeps a refusal from being vacuous; see the function's TSDoc.
  test("proves the path on the site before handing it out", async () => {
    process.env.WP_STUB_MODE = "path";
    await markerPathFromLogFolder(local());
    const php = captured();
    expect(php).toContain("realpath( $dir . '/' . $path ) !== $target");
    expect(php).toContain("! is_writable( $target )");
    expect(php).toContain("file_exists( $dir . '/' . basename( $target ) )");
  });

  for (const mode of ["inward", "elsewhere"]) {
    test(`refuses a reply that does not lead out to the marker (${mode})`, async () => {
      process.env.WP_STUB_MODE = mode;
      await expect(markerPathFromLogFolder(local())).rejects.toThrow(
        /expected a path leading out of the log folder/,
      );
    });
  }

  test("refuses when the marker was never planted, saying so", async () => {
    process.env.WP_STUB_MODE = "no-marker";
    await expect(markerPathFromLogFolder(local())).rejects.toThrow(
      /plant it first/,
    );
  });
});
