import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { failClose, withHandleMethod } from "../__fixtures__/file-handle";
import { StateError } from "./errors";
import { readStateFile } from "./read";

/** A fresh folder per test, removed after it. */
let dir: string;
test.beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "e2e-read-"));
});
test.afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** What the messages call the file. */
const WHAT = "The run counter";

/**
 * The message `readStateFile` refuses `path` with.
 *
 * @param path - the file.
 * @param maxBytes - its cap.
 */
async function refusal(path: string, maxBytes = 100): Promise<string> {
  const error: unknown = await readStateFile(path, WHAT, maxBytes).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(StateError);
  return (error as StateError).message;
}

test.describe("readStateFile", () => {
  test("reads a file's text, and nothing for a file that is not there", async () => {
    const path = join(dir, "c.json");
    expect(await readStateFile(path, WHAT, 100)).toBeUndefined();
    await writeFile(path, '{"v":1}');
    expect(await readStateFile(path, WHAT, 7)).toBe('{"v":1}');
  });

  test("refuses a link, a folder, a FIFO and an oversized file, each by name", async () => {
    const path = join(dir, "c.json");
    await writeFile(path, "12345");
    expect(await refusal(path, 4)).toBe(
      `${WHAT} ${path} is larger than its 4 bytes.`,
    );
    const link = join(dir, "link.json");
    await symlink(path, link);
    expect(await refusal(link)).toBe(
      `${WHAT} ${link} is a symbolic link: state files are never followed through one.`,
    );
    expect(await refusal(dir)).toBe(`${WHAT} ${dir} is not a regular file.`);
    const fifo = join(dir, "fifo.json");
    execFileSync("mkfifo", [fifo]);
    expect(await refusal(fifo)).toBe(`${WHAT} ${fifo} is not a regular file.`);
  });

  test("names the system error of a read that fails", async () => {
    const path = join(dir, "c.json");
    await writeFile(path, "{}");
    const message = await withHandleMethod(
      "read",
      () => Promise.reject(Object.assign(new Error("read"), { code: "EIO" })),
      () => refusal(path),
    );
    expect(message).toBe(`${WHAT} ${path} cannot be read (EIO).`);
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
      () => readStateFile(path, WHAT, 100),
    );
    expect(text).toBe("{}");
  });
});
