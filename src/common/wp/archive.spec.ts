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

import { findArchiveEntries, readArchiveEntry } from "./archive";
import type { LocalTransport } from "../config/types";

/**
 * A stub `tar` on PATH exercises these helpers plus the real exec layer without needing an archive.
 * It records the arguments it was given, which lets the tests pin the *shape* of the command — that
 * a member is named to `tar` rather than the archive being listed in full, the property that keeps a
 * gigabyte-scale archive affordable to inspect.
 *
 * **Every failure mode below is transcribed from GNU tar 1.35 on a live cell**, because the earlier
 * version of this stub invented a plausible-looking `damaged` reply that no real tar produces, and
 * that invention hid a defect: real tar prints `<pattern>: Not found in archive` for a *corrupt*
 * archive too, so deciding "absent vs. unreadable" from the message was wrong. A truncated archive
 * prints nothing else at all. The `-tf` reply with no pattern is what actually separates them.
 */
const STUB_TAR = `#!/usr/bin/env bash
printf '%s\\n' "$@" >> "$TAR_STUB_CAPTURE"
# A call with no pattern is the readability probe: "$3" is unset for \`tar -tf <archive>\`.
if [ -z "\${3:-}" ]; then
  case "$TAR_STUB_PROBE" in
    unreadable)
      printf 'tar: This does not look like a tar archive\\ntar: Exiting with failure status due to previous errors\\n' >&2
      exit 2 ;;
    empty) : ;;                       # a valid archive holding no members: exit 0, no output
    *) printf 'wp-content/\\n' ;;
  esac
  exit 0
fi
case "$TAR_STUB_MODE" in
  list)     printf 'wp-content/marker.txt\\ndb.sql\\n' ;;
  listone)  printf 'db.sql\\n' ;;
  dupes)    printf 'e2eSimple.sql\\ne2eSimple.sql\\n' ;;
  spaced)   printf ' odd name.sql \\n' ;;
  crlf)     printf 'db.sql\\r\\n' ;;
  blanks)   printf '\\n\\ndb.sql\\n\\n' ;;
  content)  printf 'MARKER-VALUE' ;;
  # Measured: a pattern that matches nothing in a *sound* archive.
  missing)  printf 'tar: nope: Not found in archive\\ntar: Exiting with failure status due to previous errors\\n' >&2; exit 2 ;;
  broken)   printf 'tar: cannot open\\n' >&2; exit 1 ;;
esac
exit 0
`;

let binDir: string;
let rootDir: string;
let capture: string;
let originalPath: string | undefined;

test.beforeAll(() => {
  binDir = mkdtempSync(join(tmpdir(), "wp-archive-stub-bin-"));
  rootDir = mkdtempSync(join(tmpdir(), "wp-archive-stub-root-"));
  capture = join(binDir, "captured-args.txt");
  const tar = join(binDir, "tar");
  writeFileSync(tar, STUB_TAR);
  chmodSync(tar, 0o755);
  originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
  process.env.TAR_STUB_CAPTURE = capture;
});

test.afterAll(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  delete process.env.TAR_STUB_CAPTURE;
  rmSync(binDir, { recursive: true, force: true });
  rmSync(rootDir, { recursive: true, force: true });
});

test.beforeEach(() => {
  writeFileSync(capture, "");
  process.env.TAR_STUB_PROBE = "readable";
});

const local = (): LocalTransport => ({ mode: "local", rootDir });

/** Every argument the stub was invoked with, across all calls, one per line. */
const capturedArgs = (): string[] =>
  readFileSync(capture, "utf8")
    .split("\n")
    .filter((line) => line !== "");

test.describe("findArchiveEntries", () => {
  test("returns the members matching the pattern", async () => {
    process.env.TAR_STUB_MODE = "list";
    expect(await findArchiveEntries(local(), "/b/a.tar", "*")).toEqual([
      "wp-content/marker.txt",
      "db.sql",
    ]);
  });

  test("asks tar for the pattern instead of listing the archive", async () => {
    // The whole point: a 2 GB archive holds tens of thousands of paths, and listing them to answer
    // "is this one file in it?" would move megabytes of text for a single assertion.
    process.env.TAR_STUB_MODE = "listone";
    await findArchiveEntries(local(), "/b/a.tar", "*.sql");
    expect(capturedArgs()).toEqual([
      "-tf",
      "/b/a.tar",
      "--wildcards",
      "--",
      "*.sql",
    ]);
  });

  test("declares no compression, so .tar and .tar.gz are one code path", async () => {
    // GNU tar detects compression when reading; passing `-z` would break plain `.tar`, and choosing
    // the flag from the file extension would put a guess in the way of an answer.
    process.env.TAR_STUB_MODE = "listone";
    await findArchiveEntries(local(), "/b/a.tar.gz", "*.sql");
    expect(capturedArgs()).not.toContain("-z");
  });

  test("reports an absent member as an empty list, not as a failure", async () => {
    process.env.TAR_STUB_MODE = "missing";
    expect(await findArchiveEntries(local(), "/b/a.tar", "nope")).toEqual([]);
  });

  test("throws when the archive is unreadable, though tar says 'Not found in archive'", async () => {
    // The defect this pins: GNU tar prints that same line for a corrupt archive, so the message
    // cannot separate "absent" from "unreadable". Reading the second as the first would turn a
    // corrupt backup into a confident "the file is not in it" — and every absence assertion built
    // on it would pass.
    process.env.TAR_STUB_MODE = "missing";
    process.env.TAR_STUB_PROBE = "unreadable";
    await expect(
      findArchiveEntries(local(), "/b/a.tar", "nope"),
    ).rejects.toThrow(/could not be read as an archive/);
  });

  test("decides that by listing the archive, never by matching tar's wording", async () => {
    process.env.TAR_STUB_MODE = "missing";
    await findArchiveEntries(local(), "/b/a.tar", "nope");
    // Two calls: the pattern query, then the no-pattern probe that settles readability.
    expect(capturedArgs()).toEqual([
      "-tf",
      "/b/a.tar",
      "--wildcards",
      "--",
      "nope",
      "-tf",
      "/b/a.tar",
    ]);
  });

  test("does not pay for the probe when the pattern matched", async () => {
    process.env.TAR_STUB_MODE = "listone";
    await findArchiveEntries(local(), "/b/a.tar", "*.sql");
    expect(capturedArgs().filter((a) => a === "-tf")).toHaveLength(1);
  });

  test("throws on any other failure", async () => {
    process.env.TAR_STUB_MODE = "broken";
    await expect(findArchiveEntries(local(), "/b/a.tar", "*")).rejects.toThrow(
      /exited 1/,
    );
  });

  test("treats a readable but empty archive as holding nothing", async () => {
    // The one shape where "readable, nothing listed" is the right answer rather than a symptom:
    // `tar -cf x --files-from /dev/null` then `tar -tf x` exits 0 with no output (measured). The
    // probe must not read that as corruption, and the caller gets an honest empty list.
    process.env.TAR_STUB_MODE = "missing";
    process.env.TAR_STUB_PROBE = "empty";
    expect(await findArchiveEntries(local(), "/b/a.tar", "*.sql")).toEqual([]);
  });

  test("collapses duplicate member names", async () => {
    // tar allows two members to share a name — a docroot file called the same thing as the database
    // dump produces exactly that — and reading the name returns both, so listing it twice would only
    // re-read the same bytes.
    process.env.TAR_STUB_MODE = "dupes";
    expect(await findArchiveEntries(local(), "/b/a.tar", "*.sql")).toEqual([
      "e2eSimple.sql",
    ]);
  });

  test("keeps spaces inside a member name, which are part of it", async () => {
    // Trimming would produce a name that no later read could find.
    process.env.TAR_STUB_MODE = "spaced";
    expect(await findArchiveEntries(local(), "/b/a.tar", "*.sql")).toEqual([
      " odd name.sql ",
    ]);
  });

  test("strips a carriage return, which is the separator and not the name", async () => {
    process.env.TAR_STUB_MODE = "crlf";
    expect(await findArchiveEntries(local(), "/b/a.tar", "*.sql")).toEqual([
      "db.sql",
    ]);
  });

  test("drops blank lines rather than reporting empty member names", async () => {
    process.env.TAR_STUB_MODE = "blanks";
    expect(await findArchiveEntries(local(), "/b/a.tar", "*.sql")).toEqual([
      "db.sql",
    ]);
  });
});

test.describe("readArchiveEntry", () => {
  test("streams the member to stdout rather than extracting it", async () => {
    process.env.TAR_STUB_MODE = "content";
    expect(await readArchiveEntry(local(), "/b/a.tar", "db.sql")).toBe(
      "MARKER-VALUE",
    );
    expect(capturedArgs()).toEqual(["-xOf", "/b/a.tar", "--", "db.sql"]);
  });

  test("takes the member name literally, with no wildcard matching", async () => {
    // A member whose name contains `*` must address that member, not act as a pattern.
    process.env.TAR_STUB_MODE = "content";
    await readArchiveEntry(local(), "/b/a.tar", "odd*name.sql");
    expect(capturedArgs()).not.toContain("--wildcards");
  });

  test("throws when the member is absent, because a caller asked for its contents", async () => {
    process.env.TAR_STUB_MODE = "missing";
    await expect(readArchiveEntry(local(), "/b/a.tar", "nope")).rejects.toThrow(
      /Not found in archive/,
    );
  });
});
