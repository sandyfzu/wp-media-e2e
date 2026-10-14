import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { failClose, withHandleMethod } from "../__fixtures__/file-handle";
import { StateError } from "./errors";
import { readStateFile, type StateFileText } from "./read";

/** A fresh folder per test, removed after it. */
let dir: string;
test.beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "e2e-read-"));
});
test.afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** What the messages call the file, and what they say to do. */
const TEXT: StateFileText = {
  what: "The run counter",
  remedy: "Remove it: rm x.",
};

/**
 * The message `readStateFile` refuses `path` with.
 *
 * @param path - the file.
 * @param maxBytes - its cap.
 */
async function refusal(path: string, maxBytes = 100): Promise<string> {
  const error: unknown = await readStateFile(path, maxBytes, TEXT).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(StateError);
  return (error as StateError).message;
}

test.describe("readStateFile", () => {
  test("reads a file's text, and nothing for a file that is not there", async () => {
    const path = join(dir, "c.json");
    expect(await readStateFile(path, 100, TEXT)).toBeUndefined();
    await writeFile(path, '{"v":1}');
    expect(await readStateFile(path, 7, TEXT)).toBe('{"v":1}');
  });

  test("refuses a link, a folder, a FIFO and an oversized file, each by name and with the remedy", async () => {
    const path = join(dir, "c.json");
    await writeFile(path, "12345");
    expect(await refusal(path, 4)).toBe(
      `${TEXT.what} ${path} is larger than its 4 bytes. ${TEXT.remedy}`,
    );
    const link = join(dir, "link.json");
    await symlink(path, link);
    expect(await refusal(link)).toBe(
      `${TEXT.what} ${link} is a symbolic link: state files are never followed through one. ${TEXT.remedy}`,
    );
    expect(await refusal(dir)).toBe(
      `${TEXT.what} ${dir} is not a regular file. ${TEXT.remedy}`,
    );
    const fifo = join(dir, "fifo.json");
    execFileSync("mkfifo", [fifo]);
    expect(await refusal(fifo)).toBe(
      `${TEXT.what} ${fifo} is not a regular file. ${TEXT.remedy}`,
    );
  });

  test("names the system error of a read that fails", async () => {
    const path = join(dir, "c.json");
    await writeFile(path, "{}");
    const message = await withHandleMethod(
      "read",
      () => Promise.reject(Object.assign(new Error("read"), { code: "EIO" })),
      () => refusal(path),
    );
    expect(message).toBe(
      `${TEXT.what} ${path} cannot be read (EIO). ${TEXT.remedy}`,
    );
  });

  test("keeps what it read when closing the file fails", async () => {
    const path = join(dir, "c.json");
    await writeFile(path, "{}");
    const text = await withHandleMethod(
      "stat",
      function (original, ...args) {
        failClose(this);
        return original(...args);
      },
      () => readStateFile(path, 100, TEXT),
    );
    expect(text).toBe("{}");
  });
});
