import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import {
  appendFile,
  chmod,
  mkdtemp,
  open,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { failClose, withHandleMethod } from "./__fixtures__/file-handle";
import { NOT_A_FILE, readAtMost, readCapped, readCappedBytes } from "./files";

/** A fresh folder per test, removed after it. */
let root: string;
test.beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "e2e-files-"));
});
test.afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/**
 * Writes a file in the test's folder.
 *
 * @param name - its name.
 * @param content - its content.
 * @returns its path.
 */
async function file(
  name: string,
  content: string | Uint8Array,
): Promise<string> {
  const path = join(root, name);
  await writeFile(path, content);
  return path;
}

test.describe("readAtMost", () => {
  test("reads a file whole when it is within the limit, and stops at the limit when it is not", async () => {
    const path = await file("f", "0123456789");
    const handle = await open(path, "r");
    try {
      expect(Buffer.from(await readAtMost(handle, 100)).toString()).toBe(
        "0123456789",
      );
      expect(Buffer.from(await readAtMost(handle, 4)).toString()).toBe("0123");
      expect((await readAtMost(handle, 0)).length).toBe(0);
    } finally {
      await handle.close();
    }
  });

  test("reads a file larger than one read's chunk byte for byte, from its start", async () => {
    const content = Buffer.alloc(200 * 1024 + 7);
    for (let i = 0; i < content.length; i++) content[i] = (i * 31) % 251;
    const path = await file("big", content);
    const handle = await open(path, "r");
    try {
      // A read already made must not shift the next one's start.
      await handle.read(Buffer.alloc(10), 0, 10, null);
      expect(Buffer.from(await readAtMost(handle, content.length))).toEqual(
        content,
      );
      expect(Buffer.from(await readAtMost(handle, 70_000))).toEqual(
        content.subarray(0, 70_000),
      );
    } finally {
      await handle.close();
    }
  });
});

test.describe("readCapped", () => {
  test("reads a file up to the cap exactly, and refuses one a byte over, naming its size", async () => {
    const path = await file("f.txt", "héllo");
    expect(await readCapped(path, 6)).toEqual({ kind: "text", text: "héllo" });
    expect(await readCapped(path, 5)).toEqual({ kind: "tooLarge", bytes: 6 });
    expect(await readCapped(path, 1)).toEqual({ kind: "tooLarge", bytes: 6 });
    expect(await readCapped(await file("empty", ""), 0)).toEqual({
      kind: "text",
      text: "",
    });
  });

  test("reads bytes that are not UTF-8 as replacement characters", async () => {
    const path = await file("latin1", Buffer.from([0x63, 0x61, 0x66, 0xe9]));
    expect(await readCapped(path, 10)).toEqual({
      kind: "text",
      text: "caf�",
    });
  });

  test("tells a missing file from a folder, which is no file to read", async () => {
    expect(await readCapped(join(root, "none"), 10)).toEqual({
      kind: "missing",
    });
    expect(await readCapped(root, 10)).toEqual({
      kind: "unreadable",
      code: NOT_A_FILE,
    });
  });

  test("refuses a FIFO without waiting for a writer", async () => {
    const fifo = join(root, "results.jsonl");
    execFileSync("mkfifo", [fifo]);
    // Nothing ever writes to it: a blocking open would wait forever, and the test time out.
    expect(await readCapped(fifo, 10)).toEqual({
      kind: "unreadable",
      code: NOT_A_FILE,
    });
  });

  test("names the system error of a file it may not read", async () => {
    test.skip(process.getuid?.() === 0, "root reads a mode 000 file");
    const path = await file("secret", "x");
    await chmod(path, 0o000);
    expect(await readCapped(path, 10)).toEqual({
      kind: "unreadable",
      code: "EACCES",
    });
  });

  test("follows a link in the file's place by default, and refuses it, dangling or not, when told not to", async () => {
    const target = await file("f.txt", "target");
    const link = join(root, "link.txt");
    const dangling = join(root, "dangling.txt");
    await symlink(target, link);
    await symlink(join(root, "none"), dangling);
    expect(await readCapped(link, 10)).toEqual({
      kind: "text",
      text: "target",
    });
    expect(await readCapped(link, 10, { followLink: false })).toEqual({
      kind: "unreadable",
      code: "ELOOP",
    });
    expect(await readCapped(dangling, 10)).toEqual({ kind: "missing" });
    expect(await readCapped(dangling, 10, { followLink: false })).toEqual({
      kind: "unreadable",
      code: "ELOOP",
    });
    // A regular file reads the same either way.
    expect(await readCapped(target, 10, { followLink: false })).toEqual({
      kind: "text",
      text: "target",
    });
  });

  test("refuses a file that grows past the cap between its stat and its read", async () => {
    const path = await file("growing", "abc");
    const read = await withHandleMethod(
      "stat",
      async function (original, ...args) {
        const stats = await original(...args);
        // Seen at 3 bytes, then written to before the read.
        await appendFile(path, "x".repeat(20));
        return stats;
      },
      () => readCapped(path, 10),
    );
    expect(read).toEqual({ kind: "tooLarge", bytes: 23 });
  });

  test("keeps what it read when closing the file fails", async () => {
    const path = await file("f", "kept");
    const read = await withHandleMethod(
      "stat",
      function (original, ...args) {
        failClose(this);
        return original(...args);
      },
      () => readCapped(path, 10),
    );
    expect(read).toEqual({ kind: "text", text: "kept" });
  });

  test("names the system error of a read that fails part-way", async () => {
    const path = await file("f", "data");
    const read = await withHandleMethod(
      "read",
      () => Promise.reject(Object.assign(new Error("read"), { code: "EIO" })),
      () => readCapped(path, 10),
    );
    expect(read).toEqual({ kind: "unreadable", code: "EIO" });
  });

  test("refuses a cap that is not a whole number from 0", async () => {
    const path = await file("f", "x");
    for (const cap of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
      await expect(readCapped(path, cap)).rejects.toThrow(RangeError);
  });
});

test.describe("readCappedBytes", () => {
  test("gives the bytes as they are, and the file's mode", async () => {
    const path = await file("cfg", Buffer.from([0xef, 0xbb, 0xbf, 0xff]));
    await chmod(path, 0o640);
    const read = await readCappedBytes(path, 4);
    expect(read.kind).toBe("bytes");
    if (read.kind !== "bytes") return;
    expect([...read.bytes]).toEqual([0xef, 0xbb, 0xbf, 0xff]);
    expect(read.mode & 0o777).toBe(0o640);
  });

  test("names an oversized file's whole size, not the bytes it read", async () => {
    const path = await file("big", "x".repeat(1000));
    expect(await readCappedBytes(path, 10)).toEqual({
      kind: "tooLarge",
      bytes: 1000,
    });
  });
});
