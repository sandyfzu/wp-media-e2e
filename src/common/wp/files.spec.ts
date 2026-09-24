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
  FILE_LIST_PHP,
  backdateFile,
  fileChecksum,
  listFiles,
  listLocatedFiles,
  parseFileList,
} from "./files";
import type { LocalTransport } from "../config/types";

/** A stub `wp` on PATH, recording the snippet it was handed so the guard clause can be pinned. */
const STUB_WP = `#!/usr/bin/env bash
printf '%s' "$2" > "$WP_STUB_CAPTURE"
case "$WP_STUB_MODE" in
  digest)  printf '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08' ;;
  upper)   printf '9F86D081884C7D659A2FEAA0C55AD015A3BF4F1B2B0B822CD15D6C15B0F00A08' ;;
  noisy)   printf 'PHP Notice: something\\n9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08' ;;
  empty)   printf '' ;;
  missing) printf 'Error: no readable file at /nope' >&2; exit 1 ;;
  # What the listing snippet printed on a live cell for a BackWPup logs folder, trimmed to two entries.
  listing)  printf '%s' '{"dir":"/site/logs","files":[{"name":".htaccess","size":175,"modified":1790181172,"writable":true},{"name":"backwpup_log_8cbb38_2026-09-23_11-32-52.html","size":3177,"modified":1790181173,"writable":true}]}' ;;
  digested) printf '%s' '{"dir":"/site/backups","files":[{"name":"a.tar","size":5,"modified":1790181172,"writable":false,"sha256":"2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"}]}' ;;
  # A file the site could not stat or hash: \`filesize()\` and \`hash_file()\` answer false.
  unstatted) printf '%s' '{"dir":"/site/backups","files":[{"name":"a.tar","size":false,"modified":1790181172,"writable":true}]}' ;;
  unhashed)  printf '%s' '{"dir":"/site/backups","files":[{"name":"a.tar","size":5,"modified":1790181172,"writable":true,"sha256":false}]}' ;;
  # A plugin's own path helper hands the folder back with a trailing slash.
  located)   printf '%s' '{"dir":"/site/wp-content/uploads/logs/","files":[]}' ;;
  no-dir)    printf 'Error: no directory at /site/nope' >&2; exit 1 ;;
  object)    printf '{}' ;;
  not-list)  printf '%s' '{"dir":"/site/logs","files":{}}' ;;
  garbled)   printf 'Warning: something\n[]' ;;
  backdated) printf '1789317173' ;;
  refused)   printf 'Error: could not set the modification time of /site/a.html (only its owner may): touch(): Utime failed: Operation not permitted' >&2; exit 1 ;;
  no-time)   printf '' ;;
esac
exit 0
`;

let binDir: string;
let rootDir: string;
let capture: string;
let originalPath: string | undefined;

test.beforeAll(() => {
  binDir = mkdtempSync(join(tmpdir(), "wp-files-stub-bin-"));
  rootDir = mkdtempSync(join(tmpdir(), "wp-files-stub-root-"));
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
  rmSync(binDir, { recursive: true, force: true });
  rmSync(rootDir, { recursive: true, force: true });
});

const local = (): LocalTransport => ({ mode: "local", rootDir });

test.describe("fileChecksum", () => {
  test("returns the digest the site computed", async () => {
    process.env.WP_STUB_MODE = "digest";
    expect(await fileChecksum(local(), "/site/a.tar")).toBe(
      "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    );
  });

  test("computes it on the site, so nothing large has to move", async () => {
    process.env.WP_STUB_MODE = "digest";
    await fileChecksum(local(), "/site/a.tar");
    expect(readFileSync(capture, "utf8")).toContain("hash_file( 'sha256'");
  });

  test("refuses a reply that is not a digest, rather than comparing noise", async () => {
    // A notice printed ahead of the value would otherwise be compared against the local digest and
    // fail as "the download differs", pointing at the wrong thing entirely.
    process.env.WP_STUB_MODE = "noisy";
    await expect(fileChecksum(local(), "/site/a.tar")).rejects.toThrow(
      /expected a SHA-256/,
    );
  });

  test("refuses an empty reply instead of returning an empty digest", async () => {
    process.env.WP_STUB_MODE = "empty";
    await expect(fileChecksum(local(), "/site/a.tar")).rejects.toThrow(
      /expected a SHA-256/,
    );
  });

  test("refuses upper-case hex, so comparisons never hinge on case", async () => {
    process.env.WP_STUB_MODE = "upper";
    await expect(fileChecksum(local(), "/site/a.tar")).rejects.toThrow(
      /expected a SHA-256/,
    );
  });

  test("throws when the file is missing, with the site's own words", async () => {
    process.env.WP_STUB_MODE = "missing";
    await expect(fileChecksum(local(), "/nope")).rejects.toThrow(
      /no readable file/,
    );
  });
});

test.describe("parseFileList", () => {
  const entry = {
    name: "a.tar",
    size: 5,
    modified: 1790181172,
    writable: true,
  };

  test("maps each entry, camel-casing the timestamp", () => {
    expect(parseFileList([entry], false)).toEqual([
      { name: "a.tar", size: 5, modifiedAt: 1790181172, writable: true },
    ]);
  });

  test("reads an empty directory as no files", () => {
    expect(parseFileList([], false)).toEqual([]);
  });

  // Each would otherwise have to be read as something it is not — and "no files" passes the
  // assertions that something was removed.
  for (const [label, value] of [
    ["an object", {}],
    ["a string", "[]"],
    ["null", null],
  ] as const) {
    test(`refuses ${label} instead of a list`, () => {
      expect(() => parseFileList(value, false)).toThrow(
        /expected a list of files/,
      );
    });
  }

  for (const [field, value] of [
    ["name", ""],
    ["size", false],
    ["size", -1],
    ["modified", 1.5],
    ["writable", 1],
  ] as const) {
    test(`refuses a ${field} of ${JSON.stringify(value)}`, () => {
      expect(() =>
        parseFileList([{ ...entry, [field]: value }], false),
      ).toThrow(new RegExp(`expected "${field}"`));
    });
  }

  test("requires a digest on every entry when digests were asked for", () => {
    expect(() => parseFileList([entry], true)).toThrow(/expected "sha256"/);
    expect(() =>
      parseFileList([{ ...entry, sha256: "2CF24DBA" }], true),
    ).toThrow(/expected "sha256"/);
  });
});

test.describe("listFiles", () => {
  test("returns the site's view of the directory", async () => {
    process.env.WP_STUB_MODE = "listing";
    const files = await listFiles(local(), "/site/logs");
    expect(files.map((file) => file.name)).toEqual([
      ".htaccess",
      "backwpup_log_8cbb38_2026-09-23_11-32-52.html",
    ]);
    expect(files[1]).toEqual({
      name: "backwpup_log_8cbb38_2026-09-23_11-32-52.html",
      size: 3177,
      modifiedAt: 1790181173,
      writable: true,
    });
  });

  test("hashes on the site when asked, and only then", async () => {
    process.env.WP_STUB_MODE = "digested";
    const [file] = await listFiles(local(), "/site/backups", { digests: true });
    expect(file?.sha256).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
    expect(readFileSync(capture, "utf8")).toContain(FILE_LIST_PHP);

    process.env.WP_STUB_MODE = "listing";
    await listFiles(local(), "/site/logs");
    // The flag reaches PHP as a literal; `true` would hash every file of a large directory.
    expect(readFileSync(capture, "utf8")).toMatch(
      /\$digests = json_decode\( base64_decode\( 'ZmFsc2U=' \), true \);/,
    );
  });

  // A path that was simply wrong would otherwise list as empty and pass "it was deleted".
  test("refuses a directory that is not there, in the site's own words", async () => {
    process.env.WP_STUB_MODE = "no-dir";
    await expect(listFiles(local(), "/site/nope")).rejects.toThrow(
      /no directory at \/site\/nope/,
    );
    // Pinned as the guard *and* its refusal: an emptied body would keep the condition and list the
    // missing directory as nothing.
    expect(readFileSync(capture, "utf8")).toContain(
      "if ( ! is_dir( $dir ) ) {\n\tWP_CLI::error( 'no directory at ' . $dir );\n}",
    );
  });

  test("refuses an entry the site could not stat or hash", async () => {
    process.env.WP_STUB_MODE = "unstatted";
    await expect(listFiles(local(), "/site/backups")).rejects.toThrow(
      /expected "size" to be a byte count/,
    );
    process.env.WP_STUB_MODE = "unhashed";
    await expect(
      listFiles(local(), "/site/backups", { digests: true }),
    ).rejects.toThrow(/expected "sha256" to be a SHA-256/);
  });

  test("refuses a reply that is not a list of files", async () => {
    process.env.WP_STUB_MODE = "object";
    await expect(listFiles(local(), "/site/logs")).rejects.toThrow(
      /not a directory and its files/,
    );
    process.env.WP_STUB_MODE = "not-list";
    await expect(listFiles(local(), "/site/logs")).rejects.toThrow(
      /expected a list of files/,
    );
    process.env.WP_STUB_MODE = "garbled";
    await expect(listFiles(local(), "/site/logs")).rejects.toThrow(
      /did not come back as JSON/,
    );
  });

  // Only for a directory a scenario may never have created: the refusal above stays in the snippet,
  // behind the directory's existence, so a directory that is there is still listed in full.
  test("reads a directory that is not there as empty, only when asked to", async () => {
    process.env.WP_STUB_MODE = "located";
    expect(
      await listFiles(local(), "/site/nope", { missingAsEmpty: true }),
    ).toEqual([]);
    const php = readFileSync(capture, "utf8");
    expect(php).toContain(
      `clearstatcache();\n$files = [];\nif ( is_dir( $dir ) ) {\n${FILE_LIST_PHP}}\n`,
    );

    await listFiles(local(), "/site/nope");
    expect(readFileSync(capture, "utf8")).not.toContain("$files = [];\nif (");
  });
});

test.describe("listLocatedFiles", () => {
  test("locates the directory first, then lists it, and says where it was", async () => {
    process.env.WP_STUB_MODE = "located";
    const locate = "$dir = plugin_log_folder();\n";
    const listed = await listLocatedFiles(local(), locate, "the log folder");
    expect(listed).toEqual({ dir: "/site/wp-content/uploads/logs", files: [] });
    const php = readFileSync(capture, "utf8");
    expect(php.startsWith(locate)).toBe(true);
    expect(php).toContain(FILE_LIST_PHP);
    expect(
      php.endsWith(
        "echo wp_json_encode( [ 'dir' => $dir, 'files' => $files ] );",
      ),
    ).toBe(true);
  });

  test("names the directory in words when the reply cannot be read", async () => {
    process.env.WP_STUB_MODE = "garbled";
    await expect(
      listLocatedFiles(local(), "$dir = '/x';\n", "the log folder"),
    ).rejects.toThrow("listing the log folder did not come back as JSON");
  });
});

test.describe("backdateFile", () => {
  test("returns the time the file now carries", async () => {
    process.env.WP_STUB_MODE = "backdated";
    expect(await backdateFile(local(), "/site/a.html", 864_000)).toBe(
      1789317173,
    );
  });

  // The site's clock decides, so the offset travels and the time is computed there.
  test("counts back from the site's own clock", async () => {
    process.env.WP_STUB_MODE = "backdated";
    await backdateFile(local(), "/site/a.html", 864_000);
    const php = readFileSync(capture, "utf8");
    expect(php).toContain(
      "$time = time() - json_decode( base64_decode( 'ODY0MDAw' ), true );",
    );
    expect(php).toContain("filemtime( $path ) !== $time");
  });

  for (const seconds of [0, -1, 1.5, Number.NaN]) {
    test(`refuses to backdate by ${String(seconds)} s, before asking the site`, async () => {
      process.env.WP_STUB_MODE = "backdated";
      writeFileSync(capture, "untouched");
      await expect(
        backdateFile(local(), "/site/a.html", seconds),
      ).rejects.toThrow(/positive whole number/);
      expect(readFileSync(capture, "utf8")).toBe("untouched");
    });
  }

  test("passes on the site's refusal", async () => {
    process.env.WP_STUB_MODE = "refused";
    await expect(backdateFile(local(), "/site/a.html", 60)).rejects.toThrow(
      /only its owner may/,
    );
  });

  test("refuses a reply that is not a timestamp", async () => {
    process.env.WP_STUB_MODE = "no-time";
    await expect(backdateFile(local(), "/site/a.html", 60)).rejects.toThrow(
      /expected the timestamp/,
    );
  });
});
