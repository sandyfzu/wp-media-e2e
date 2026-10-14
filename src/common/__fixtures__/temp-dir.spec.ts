import { test, expect } from "@playwright/test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isTempDir, removeTempDir } from "./temp-dir";

/** The removal guard every spec's temporary folder goes through. */

test("removes a folder inside the temporary folder, by either spelling", () => {
  for (const base of [tmpdir(), realpathSync(tmpdir())]) {
    const dir = mkdtempSync(join(base, "e2e-temp-dir-"));
    mkdirSync(join(dir, "a", "b"), { recursive: true });
    expect(isTempDir(dir)).toBe(true);
    removeTempDir(dir);
    expect(existsSync(dir)).toBe(false);
  }
});

test("an empty path, never set, removes nothing and does not throw", () => {
  expect(isTempDir("")).toBe(false);
  expect(() => {
    removeTempDir("");
  }).not.toThrow();
});

test("refuses a relative path, a parent, the temporary folder itself and anything outside it", () => {
  const dir = mkdtempSync(join(tmpdir(), "e2e-temp-dir-"));
  try {
    for (const path of [
      "..",
      ".",
      "x",
      join("", ".."),
      tmpdir(),
      realpathSync(tmpdir()),
      join(dir, "..", ".."),
      process.cwd(),
      "/",
    ]) {
      expect(isTempDir(path), path).toBe(false);
      if (path !== "")
        expect(() => {
          removeTempDir(path);
        }, path).toThrow("refusing to remove");
    }
    expect(existsSync(dir)).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refuses a link inside the temporary folder that leads outside it", () => {
  const dir = mkdtempSync(join(tmpdir(), "e2e-temp-dir-"));
  try {
    symlinkSync(process.cwd(), join(dir, "out"));
    expect(isTempDir(join(dir, "out"))).toBe(false);
    expect(() => {
      removeTempDir(join(dir, "out"));
    }).toThrow("refusing to remove");
    expect(existsSync(process.cwd())).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refuses a relative path even when the working directory is a temporary folder", () => {
  const dir = mkdtempSync(join(tmpdir(), "e2e-temp-dir-"));
  const cwd = process.cwd();
  try {
    mkdirSync(join(dir, "x"));
    process.chdir(dir);
    expect(isTempDir("x")).toBe(false);
    expect(() => {
      removeTempDir("x");
    }).toThrow("refusing to remove");
    expect(existsSync(join(dir, "x"))).toBe(true);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});
