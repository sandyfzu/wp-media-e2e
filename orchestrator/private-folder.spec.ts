import { test, expect } from "@playwright/test";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertPrivateFolder } from "./private-folder";

test.describe("assertPrivateFolder", () => {
  /** A fresh folder per test, removed after it. */
  let dir: string;
  test.beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "e2e-private-"));
  });
  test.afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("accepts this user's folder closed to everyone else", async () => {
    await expect(assertPrivateFolder(dir, "test folder")).resolves.toBe(
      undefined,
    );
  });

  test("refuses a folder with any group or other bit", async () => {
    for (const mode of [0o750, 0o701, 0o710, 0o704]) {
      await chmod(dir, mode);
      await expect(
        assertPrivateFolder(dir, "test folder"),
        mode.toString(8),
      ).rejects.toThrow(
        `The test folder must be this user's alone (mode 0700): ${dir} is mode ${mode.toString(8)}.`,
      );
    }
  });

  test("refuses another user's folder", async () => {
    await expect(
      assertPrivateFolder(dir, "test folder", (process.getuid?.() ?? 0) + 1),
    ).rejects.toThrow(`The test folder must be this user's: ${dir} is not.`);
  });

  test("refuses a link to a folder, and a file", async () => {
    const real = join(dir, "real");
    await mkdir(real, { mode: 0o700 });
    const linked = join(dir, "linked");
    await symlink(real, linked);
    await expect(assertPrivateFolder(linked, "test folder")).rejects.toThrow(
      `The test folder is not a folder: ${linked}.`,
    );
    const file = join(dir, "file");
    await writeFile(file, "");
    await expect(assertPrivateFolder(file, "test folder")).rejects.toThrow(
      `The test folder is not a folder: ${file}.`,
    );
  });

  test("passes on lstat's error for a missing folder", async () => {
    await expect(
      assertPrivateFolder(join(dir, "missing"), "test folder"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
