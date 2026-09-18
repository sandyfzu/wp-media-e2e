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

import { fileChecksum } from "./files";
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
