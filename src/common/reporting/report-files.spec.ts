import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TAIL_BYTES, spliceIntoTail, writeFileAtomic } from "./report-files";

/**
 * Writing into a report folder: a file replaced whole, never half-written and never leaving its
 * temporary behind; a large file's end rewritten without reading the rest, and only grown.
 */

let dir = "";

test.beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "e2e-report-files-"));
});

test.afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test.describe("writeFileAtomic", () => {
  test("creates the folder, writes the file, and replaces it whole the next time", () => {
    const path = join(dir, "a", "b", "facts.json");
    writeFileAtomic(path, "first, and longer\n");
    writeFileAtomic(path, "second\n");
    expect(readFileSync(path, "utf8")).toBe("second\n");
    expect(readdirSync(join(dir, "a", "b"))).toEqual(["facts.json"]);
  });

  test("a write that fails throws, keeps no temporary file, and leaves what was there", () => {
    // A folder where the file should be: the rename cannot replace it.
    const path = join(dir, "taken");
    mkdirSync(path);
    writeFileSync(join(path, "inside"), "kept");
    expect(() => {
      writeFileAtomic(path, "x");
    }).toThrow();
    expect(readdirSync(dir)).toEqual(["taken"]);
    expect(readFileSync(join(path, "inside"), "utf8")).toBe("kept");
  });
});

test.describe("spliceIntoTail", () => {
  /** A splice inserting `text` before the last `</end>`. */
  const before =
    (text: string) =>
    (tail: Buffer): { offset: number; bytes: Buffer } | undefined => {
      const offset = tail.lastIndexOf("</end>");
      return offset < 0
        ? undefined
        : {
            offset,
            bytes: Buffer.concat([Buffer.from(text), tail.subarray(offset)]),
          };
    };

  test("rewrites the end of a small file in place", () => {
    const path = join(dir, "small.html");
    writeFileSync(path, "<start>body</end>\n");
    expect(spliceIntoTail(path, before("[banner]"))).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("<start>body[banner]</end>\n");
  });

  test("reads only the last bytes of a large file, its start left as it was", () => {
    const path = join(dir, "large.html");
    // An earlier `</end>` beyond the tail it reads must not be found.
    const head = `</end>${"x".repeat(3 * TAIL_BYTES)}`;
    writeFileSync(path, `${head}é</end>\n`);
    const seen: number[] = [];
    expect(
      spliceIntoTail(path, (tail) => {
        seen.push(tail.length);
        return before("[banner]")(tail);
      }),
    ).toBe(true);
    expect(seen).toEqual([TAIL_BYTES]);
    expect(readFileSync(path, "utf8")).toBe(`${head}é[banner]</end>\n`);
  });

  test("a splice that declines leaves the file as it was", () => {
    const path = join(dir, "cut.html");
    writeFileSync(path, "<start>cut short");
    expect(spliceIntoTail(path, before("[banner]"))).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("<start>cut short");
  });

  test("refuses a splice that would shorten the file", () => {
    const path = join(dir, "short.html");
    writeFileSync(path, "abc</end>\n");
    expect(() =>
      spliceIntoTail(path, () => ({ offset: 0, bytes: Buffer.from("x") })),
    ).toThrow(RangeError);
    expect(readFileSync(path, "utf8")).toBe("abc</end>\n");
  });

  test("throws for a file that is not there; leaves a FIFO alone without blocking", () => {
    expect(() => spliceIntoTail(join(dir, "none"), before("x"))).toThrow();
    const fifo = join(dir, "fifo");
    execFileSync("mkfifo", [fifo]);
    expect(spliceIntoTail(fifo, before("x"))).toBe(false);
  });
});
