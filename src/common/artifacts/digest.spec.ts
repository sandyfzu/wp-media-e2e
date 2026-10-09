import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isSha256, sha256File } from "./digest";

/** Unit tests for the zip digest: the hash of known bytes, a missing file, and the format check. */

let tmp: string;

test.beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "artifact-digest-"));
});
test.afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** SHA-256 of the three bytes `abc` (FIPS 180-2, appendix B.1). */
const ABC_SHA256 =
  "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

/** SHA-256 of no bytes at all. */
const EMPTY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

test("hashes a file's bytes to the published test vector", async () => {
  const path = join(tmp, "abc.zip");
  writeFileSync(path, "abc");
  expect(await sha256File(path)).toBe(ABC_SHA256);
});

test("hashes an empty file", async () => {
  const path = join(tmp, "empty.zip");
  writeFileSync(path, "");
  expect(await sha256File(path)).toBe(EMPTY_SHA256);
});

test("hashes a file larger than one read chunk the same as in one piece", async () => {
  // 1 MiB + 1 byte spans many 64 KiB stream chunks; the digest must not depend on chunking.
  const bytes = Buffer.alloc(1024 * 1024 + 1, 7);
  const path = join(tmp, "big.zip");
  writeFileSync(path, bytes);
  expect(await sha256File(path)).toBe(
    createHash("sha256").update(bytes).digest("hex"),
  );
});

test("rejects with the read error for a missing file", async () => {
  await expect(sha256File(join(tmp, "missing.zip"))).rejects.toThrow(/ENOENT/);
});

test("isSha256 accepts only 64 lowercase hex characters", () => {
  expect(isSha256(ABC_SHA256)).toBe(true);
  expect(isSha256(ABC_SHA256.toUpperCase())).toBe(false);
  expect(isSha256(ABC_SHA256.slice(1))).toBe(false);
  expect(isSha256(`${ABC_SHA256}0`)).toBe(false);
  expect(isSha256(` ${ABC_SHA256}`)).toBe(false);
  expect(isSha256("g".repeat(64))).toBe(false);
  expect(isSha256(undefined)).toBe(false);
  expect(isSha256(42)).toBe(false);
});
