import { test, expect } from "@playwright/test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DOWNLOADS_CATEGORY,
  DownloadFolder,
  PLACED_FILE_CONTENT,
  downloadFolderKey,
  pathFromWorkingDir,
} from "./download-folder";
import type { LocalTransport } from "../../../common/config/types";

/**
 * A stub `wp` on PATH. The snippet that prepares the folder is recognised by its `mkdir`, counted,
 * and answered with the mode `$WP_STUB_MODE_FOR_PREPARE` (`700` by default), the folder's real path
 * `$WP_STUB_PREPARED_PATH` and WP-CLI's working directory `$WP_STUB_CWD`; every other snippet is
 * recorded, and answered by `$WP_STUB_MODE`.
 */
const STUB_WP = `#!/usr/bin/env bash
case "$2" in
  *"mkdir( \\$dir, 0700 )"*)
    printf '%s' "$2" > "$WP_STUB_CAPTURE.prepare"
    printf 'x\\n' >> "$WP_STUB_CAPTURE.prepares"
    printf '{"mode":"%s","path":"%s","cwd":"%s"}' "\${WP_STUB_MODE_FOR_PREPARE:-700}" "$WP_STUB_PREPARED_PATH" "$WP_STUB_CWD"
    exit 0 ;;
esac
printf '%s' "$2" > "$WP_STUB_CAPTURE"
case "$WP_STUB_MODE" in
  placed)  printf 'placed' ;;
  differs) printf 'differs' ;;
  refused) printf 'Error: could not write /x/existing.tar' >&2; exit 1 ;;
  listed)  printf '%s' '{"dir":"/x","files":[{"name":"copy.tar","size":5,"modified":1,"writable":true,"sha256":"2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"}]}' ;;
  none)    printf '%s' '{"dir":"/x","files":[]}' ;;
  garbled) printf 'Warning: x' ;;
esac
exit 0
`;

let binDir: string;
let capture: string;
let originalPath: string | undefined;
let rootDir: string;

test.beforeAll(() => {
  binDir = mkdtempSync(join(tmpdir(), "bwp-downloads-bin-"));
  capture = join(binDir, "captured-php.txt");
  writeFileSync(join(binDir, "wp"), STUB_WP);
  chmodSync(join(binDir, "wp"), 0o755);
  originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
  process.env.WP_STUB_CAPTURE = capture;
});

test.beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), "bwp-downloads-root-"));
  rmSync(`${capture}.prepares`, { force: true });
  delete process.env.WP_STUB_MODE_FOR_PREPARE;
  // Where the site says the folder and WP-CLI are: the configured paths, unless a test moves them.
  process.env.WP_STUB_CWD = rootDir;
  process.env.WP_STUB_PREPARED_PATH = join(
    rootDir,
    ".e2e_temp",
    DOWNLOADS_CATEGORY,
    "abc-r0",
  );
});

test.afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

test.afterAll(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  delete process.env.WP_STUB_CAPTURE;
  delete process.env.WP_STUB_MODE;
  delete process.env.WP_STUB_CWD;
  delete process.env.WP_STUB_PREPARED_PATH;
  rmSync(binDir, { recursive: true, force: true });
});

// Elevation is refused outright, so a removal that fails never reaches this machine's own `sudo`.
const local = (extra: Partial<LocalTransport> = {}): LocalTransport => ({
  mode: "local",
  rootDir,
  elevate: false,
  ...extra,
});

/** How many times the folder was prepared on the site. */
const prepares = (): number =>
  existsSync(`${capture}.prepares`)
    ? readFileSync(`${capture}.prepares`, "utf8").split("\n").length - 1
    : 0;

test.describe("downloadFolderKey", () => {
  test("names the folder after the test and its attempt, then a random part", () => {
    expect(
      downloadFolderKey({ testId: "4e2b1c9d0a-8f7e6d5c4b3a", retry: 1 }),
    ).toMatch(/^4e2b1c9d0a-8f7e6d5c4b3a-r1-[0-9a-f]{16}$/);
  });

  // The test id is derived from the repository, so without the random part the name — and the URL a
  // copy of a backup would sit at, on a host whose web server can read the folder — is guessable.
  test("never names two folders alike", () => {
    const testInfo = { testId: "4e2b1c9d0a-8f7e6d5c4b3a", retry: 0 };
    expect(downloadFolderKey(testInfo)).not.toBe(downloadFolderKey(testInfo));
  });

  // The name ends up in a path and on a command line split on whitespace.
  for (const testId of ["a b", "a/b", "a'b", ""]) {
    test(`refuses a test id it could not carry (${JSON.stringify(testId)})`, () => {
      expect(() => downloadFolderKey({ testId, retry: 0 })).toThrow(
        /cannot name a folder/,
      );
    });
  }
});

test.describe("DownloadFolder paths", () => {
  test("sits in the staging area's downloads category, handed out relative to where WP-CLI runs", async () => {
    const folder = new DownloadFolder(local(), "abc-r0");
    expect(await folder.absolutePath()).toBe(
      join(rootDir, ".e2e_temp", DOWNLOADS_CATEGORY, "abc-r0"),
    );
    expect(await folder.relativePath()).toBe(".e2e_temp/downloads/abc-r0");
  });

  // A staging area moved outside the docroot is still reached from the root, by climbing out.
  test("reaches a staging area outside the root by a path that climbs out of it", async () => {
    const outside = join(tmpdir(), "bwp-downloads-staging");
    process.env.WP_STUB_PREPARED_PATH = join(
      outside,
      DOWNLOADS_CATEGORY,
      "abc-r0",
    );
    const folder = new DownloadFolder(local({ stagingDir: outside }), "abc-r0");
    const relative = await folder.relativePath();
    expect(relative.startsWith("../")).toBe(true);
    expect(join(rootDir, relative)).toBe(
      join(outside, DOWNLOADS_CATEGORY, "abc-r0"),
    );
  });

  // A root and a staging area each reached through a symlink: climbing out of the root climbs out of
  // its target, so a path worked out from either configured path would lead where the folder is not.
  test("works the path out from where the site says the folder and WP-CLI really are", async () => {
    process.env.WP_STUB_CWD = "/srv/releases/42";
    process.env.WP_STUB_PREPARED_PATH = "/data/e2e/downloads/abc-r0";
    const folder = new DownloadFolder(
      local({ stagingDir: "/var/www/e2e" }),
      "abc-r0",
    );
    expect(await folder.absolutePath()).toBe("/var/www/e2e/downloads/abc-r0");
    expect(await folder.relativePath()).toBe(
      "../../../data/e2e/downloads/abc-r0",
    );
  });

  test("refuses a name that is not a single safe segment", () => {
    expect(() => new DownloadFolder(local(), "../up")).toThrow(
      /not a usable folder name/,
    );
  });
});

test.describe("DownloadFolder — the folder is private", () => {
  // The web server serves what it can read inside the docroot; a folder only its owner may enter is
  // one it cannot.
  // Created private rather than made private afterwards: no `chmod` in the docroot, and a `umask` can
  // only narrow the mode, which the reply then shows.
  test("is created with mode 0700 before it is handed out, and the mode is read back", async () => {
    await new DownloadFolder(local(), "abc-r0").relativePath();
    const php = readFileSync(`${capture}.prepare`, "utf8");
    expect(php).toContain(
      "if ( ! is_dir( $dir ) && ! mkdir( $dir, 0700 ) ) {\n\tWP_CLI::error( 'could not create ' . $dir );\n}",
    );
    expect(php).not.toContain("chmod(");
    const cleared = php.indexOf("clearstatcache( true, $dir );\necho");
    expect(cleared).toBeGreaterThan(-1);
    expect(php).toContain(
      "echo wp_json_encode( [ 'mode' => decoct( fileperms( $dir ) & 0777 ), 'path' => realpath( $dir ), 'cwd' => getcwd() ] );",
    );
  });

  test("refuses a folder that did not come out private", async () => {
    process.env.WP_STUB_MODE_FOR_PREPARE = "775";
    await expect(
      new DownloadFolder(local(), "abc-r0").relativePath(),
    ).rejects.toThrow(/came out with mode "775", not 700/);
  });

  test("is prepared once, however often it is used", async () => {
    process.env.WP_STUB_MODE = "placed";
    const folder = new DownloadFolder(local(), "abc-r0");
    await folder.place("existing.tar");
    await folder.relativePath();
    await folder.relativePath();
    expect(prepares()).toBe(1);
  });

  // Reading never creates it: a folder nobody used stays absent.
  test("is not prepared just to be listed", async () => {
    process.env.WP_STUB_MODE = "none";
    await new DownloadFolder(local(), "abc-r0").list();
    expect(prepares()).toBe(0);
  });
});

test.describe("pathFromWorkingDir", () => {
  const reply = (fields: Record<string, unknown>): string =>
    JSON.stringify({ mode: "700", path: "/site/f", cwd: "/site", ...fields });

  test("leads from WP-CLI's working directory to the folder", () => {
    expect(pathFromWorkingDir(reply({}), "/site/f")).toBe("f");
    expect(
      pathFromWorkingDir(reply({ path: "/a/b/f", cwd: "/a/c/d" }), "/x"),
    ).toBe("../../b/f");
  });

  // `realpath()` answers false for a folder it cannot resolve, and a path worked out from a guess
  // could send the copy anywhere.
  for (const fields of [
    { path: false },
    { cwd: false },
    { path: "relative/f" },
    { cwd: "" },
  ]) {
    test(`refuses a reply that does not say where both are (${JSON.stringify(fields)})`, () => {
      expect(() => pathFromWorkingDir(reply(fields), "/site/f")).toThrow(
        /could not say where \/site\/f is/,
      );
    });
  }

  test("refuses a folder that did not come out private, whatever else it says", () => {
    expect(() => pathFromWorkingDir(reply({ mode: "755" }), "/site/f")).toThrow(
      /came out with mode "755", not 700/,
    );
  });

  test("refuses a reply that is not JSON", () => {
    expect(() => pathFromWorkingDir("Warning: x", "/site/f")).toThrow(
      /preparing \/site\/f did not come back as JSON/,
    );
  });
});

test.describe("DownloadFolder.place", () => {
  test("writes the known content into the prepared folder and checks it back", async () => {
    process.env.WP_STUB_MODE = "placed";
    await new DownloadFolder(local(), "abc-r0").place("existing.tar");
    const php = readFileSync(capture, "utf8");
    expect(php).toContain("file_put_contents( $path, $content )");
    expect(php).toContain("file_get_contents( $path ) === $content");
    const literal =
      /\$content = json_decode\( base64_decode\( '([^']+)' \), true \);/.exec(
        php,
      );
    expect(
      JSON.parse(Buffer.from(literal?.[1] ?? "", "base64").toString()),
    ).toBe(PLACED_FILE_CONTENT);
    expect(prepares()).toBe(1);
  });

  test("refuses a file that did not read back as written", async () => {
    process.env.WP_STUB_MODE = "differs";
    await expect(
      new DownloadFolder(local(), "abc-r0").place("existing.tar"),
    ).rejects.toThrow(/did not read back as written/);
  });

  test("passes on the site's refusal", async () => {
    process.env.WP_STUB_MODE = "refused";
    await expect(
      new DownloadFolder(local(), "abc-r0").place("existing.tar"),
    ).rejects.toThrow(/could not write/);
  });

  test("refuses a name that would leave the folder, before creating or writing anything", async () => {
    process.env.WP_STUB_MODE = "placed";
    writeFileSync(capture, "untouched");
    await expect(
      new DownloadFolder(local(), "abc-r0").place("../escape.tar"),
    ).rejects.toThrow(/not a valid staging path segment/);
    expect(readFileSync(capture, "utf8")).toBe("untouched");
    expect(prepares()).toBe(0);
  });
});

test.describe("DownloadFolder.list", () => {
  test("reads what the folder holds, with digests", async () => {
    process.env.WP_STUB_MODE = "listed";
    const [file] = await new DownloadFolder(local(), "abc-r0").list();
    expect(file?.name).toBe("copy.tar");
    expect(file?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("reads a folder that does not exist as holding nothing", async () => {
    process.env.WP_STUB_MODE = "none";
    expect(await new DownloadFolder(local(), "abc-r0").list()).toEqual([]);
    // The whole listing sits behind the folder's existence, so an absent folder never reaches the
    // listing's own refusal of a missing directory.
    expect(readFileSync(capture, "utf8")).toContain(
      "$files = [];\nif ( is_dir( $dir ) ) {\n",
    );
  });

  test("refuses a reply that is not a list of files", async () => {
    process.env.WP_STUB_MODE = "garbled";
    await expect(new DownloadFolder(local(), "abc-r0").list()).rejects.toThrow(
      /did not come back as JSON/,
    );
  });
});

test.describe("DownloadFolder.release", () => {
  /** A download left in the category, as the command under test would leave it. */
  function leaveDownload(): string {
    const dir = join(rootDir, ".e2e_temp", DOWNLOADS_CATEGORY, "abc-r0");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "copy.tar"), "archive");
    return join(rootDir, ".e2e_temp", DOWNLOADS_CATEGORY);
  }

  // Its own folder only: the category can hold another run's downloads when the staging root is
  // shared by the sites on one host.
  test("removes its own folder once it was handed out, and nothing beside it", async () => {
    const category = leaveDownload();
    const other = join(category, "someone-else-r0");
    mkdirSync(other);
    writeFileSync(join(other, "copy.tar"), "another run's archive");
    const folder = new DownloadFolder(local(), "abc-r0");
    await folder.relativePath();
    await folder.release();
    expect(existsSync(join(category, "abc-r0"))).toBe(false);
    expect(existsSync(join(other, "copy.tar"))).toBe(true);
  });

  // A preparation that failed may still have left the folder behind, half-made.
  test("removes a folder whose preparation failed", async () => {
    const category = leaveDownload();
    process.env.WP_STUB_MODE_FOR_PREPARE = "775";
    const folder = new DownloadFolder(local(), "abc-r0");
    await expect(folder.relativePath()).rejects.toThrow(/not 700/);
    await folder.release();
    expect(existsSync(join(category, "abc-r0"))).toBe(false);
  });

  // A scenario that never used the folder costs nothing at the end, not even a round trip.
  test("does nothing for a scenario that never used the folder", async () => {
    const category = leaveDownload();
    await new DownloadFolder(local(), "abc-r0").release();
    expect(existsSync(category)).toBe(true);
  });

  test("reports a removal that failed rather than failing the scenario", async () => {
    const category = leaveDownload();
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (message: string) => warnings.push(message);
    chmodSync(category, 0o555);
    try {
      const folder = new DownloadFolder(local(), "abc-r0");
      await folder.relativePath();
      await folder.release();
      expect(warnings.join(" ")).toMatch(
        /could not remove the scenario's downloads/,
      );
    } finally {
      console.warn = warn;
      chmodSync(category, 0o755);
    }
  });
});
