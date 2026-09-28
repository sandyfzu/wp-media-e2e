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
  HEADER_BYTES,
  KEY_KINDS,
  parseEncryptionHeader,
  readEncryptionHeader,
  temporaryFilesBeside,
} from "./encryption";
import type { SiteFile } from "../../../common/wp/files";
import type { LocalTransport } from "../../../common/config/types";

// First bytes measured on a live cell: an archive encrypted with a hex key, one encrypted with a
// public key file, and a plain tar, whose first member is the database dump.
const SYMMETRIC = "4241434b575055500201";
const PUBLIC_KEY = "4241434b575055500202";
const PLAIN_TAR = "65326553696d706c652e";

/** A stub `wp` on PATH, recording the snippet and answering with `$WP_STUB_REPLY`. */
const STUB_WP = `#!/usr/bin/env bash
printf '%s' "$2" > "$WP_STUB_CAPTURE"
if [ "$WP_STUB_REPLY" = "refused" ]; then
  printf 'Error: no archive a.tar in /site/backups/' >&2
  exit 1
fi
printf '%s' "$WP_STUB_REPLY"
exit 0
`;

let binDir: string;
let capture: string;
let originalPath: string | undefined;

test.beforeAll(() => {
  binDir = mkdtempSync(join(tmpdir(), "bwp-encryption-bin-"));
  capture = join(binDir, "captured-php.txt");
  writeFileSync(join(binDir, "wp"), STUB_WP);
  chmodSync(join(binDir, "wp"), 0o755);
  originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
  process.env.WP_STUB_CAPTURE = capture;
});

test.afterAll(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  delete process.env.WP_STUB_CAPTURE;
  delete process.env.WP_STUB_REPLY;
  rmSync(binDir, { recursive: true, force: true });
});

const local = (): LocalTransport => ({ mode: "local", rootDir: binDir });

test.describe("parseEncryptionHeader", () => {
  test("reads the version and the key type off an encrypted archive", () => {
    expect(parseEncryptionHeader(SYMMETRIC)).toEqual({
      version: 2,
      type: KEY_KINDS["symmetric key"],
    });
    expect(parseEncryptionHeader(PUBLIC_KEY)).toEqual({
      version: 2,
      type: KEY_KINDS["public key"],
    });
  });

  test("reads a plain archive as not encrypted", () => {
    expect(parseEncryptionHeader(PLAIN_TAR)).toBeUndefined();
  });

  // Too short to be a header, or nothing at all — neither is an encrypted archive.
  test("reads bytes too few to hold a header as not encrypted", () => {
    expect(parseEncryptionHeader(SYMMETRIC.slice(0, 18))).toBeUndefined();
    expect(parseEncryptionHeader("")).toBeUndefined();
  });

  // A notice ahead of the bytes would otherwise read as "this archive is not encrypted".
  for (const reply of [
    "Notice: x",
    "4241434b57505550020",
    "4241434B575055500201",
  ]) {
    test(`refuses a reply that is not the archive's bytes (${JSON.stringify(reply)})`, () => {
      expect(() => parseEncryptionHeader(reply)).toThrow(/as hex/);
    });
  }
});

test.describe("readEncryptionHeader", () => {
  test("reads the archive's first bytes in its job's backup folder, on the site", async () => {
    process.env.WP_STUB_REPLY = SYMMETRIC;
    expect(await readEncryptionHeader(local(), 3, "a.tar")).toEqual({
      version: 2,
      type: 1,
    });
    const php = readFileSync(capture, "utf8");
    expect(php).toContain("BackWPup_Option::get(");
    expect(php).toContain("$handle = fopen( $path, 'rb' );");
    expect(php).toContain(
      `$head = fread( $handle, json_decode( base64_decode( '${Buffer.from(String(HEADER_BYTES)).toString("base64")}' ), true ) );`,
    );
    expect(php).toContain("echo bin2hex( false === $head ? '' : $head );");
  });

  test("passes on the site's answer that the folder holds no such archive", async () => {
    process.env.WP_STUB_REPLY = "refused";
    await expect(readEncryptionHeader(local(), 3, "a.tar")).rejects.toThrow(
      /no archive a.tar/,
    );
  });

  test("refuses a name that is not an archive's before asking the site", async () => {
    await expect(
      readEncryptionHeader(local(), 3, "../wp-config.php"),
    ).rejects.toThrow(/is not an archive's name/);
  });
});

test.describe("temporaryFilesBeside", () => {
  const file = (name: string): SiteFile => ({
    name,
    size: 0,
    modifiedAt: 1,
    writable: true,
  });

  test("names the commands' leftovers beside the archive, and only those", () => {
    const files = [
      "a.tar",
      "a.tar.encrypted",
      "a.tar.decrypted",
      "b.tar.encrypted",
      "a.tar.bak",
      ".htaccess",
    ].map(file);
    expect(temporaryFilesBeside(files, "a.tar")).toEqual([
      "a.tar.encrypted",
      "a.tar.decrypted",
    ]);
  });

  test("finds none beside an archive the commands left clean", () => {
    expect(
      temporaryFilesBeside(["a.tar", "index.php"].map(file), "a.tar"),
    ).toEqual([]);
  });
});
