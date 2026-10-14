import { test, expect } from "@playwright/test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runIdOf } from "../runs/identity";
import {
  COUNTER_VERSION,
  counterPath,
  nextAfter,
  nextRunNumber,
  TASKS_DIR,
} from "./counter";
import { StateError } from "./errors";

/** A fresh state directory per test, removed after it. */
let dir: string;
let tasks: string;
let file: string;
test.beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "e2e-counter-"));
  tasks = join(dir, TASKS_DIR);
  file = join(tasks, "bpng.json");
});
test.afterEach(async () => {
  // A folder a test made read-only must be writable again to go.
  await chmod(tasks, 0o700).catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
});

/**
 * A counter file's text.
 *
 * @param lastRun - the last number handed out, as JSON would hold it.
 */
function counterText(lastRun: unknown): string {
  return JSON.stringify({ v: COUNTER_VERSION, lastRun });
}

test.describe("counterPath", () => {
  test("is tasks/<id>.json in the state directory", () => {
    expect(counterPath("/state", "bpng")).toBe("/state/tasks/bpng.json");
  });

  for (const id of ["", "../x", "bp/ng", "BPNG", "bpng.", "bpngg", ".."])
    test(`refuses ${JSON.stringify(id)}, which is not a task's id`, () => {
      expect(() => counterPath("/state", id)).toThrow(RangeError);
    });
});

test.describe("nextAfter", () => {
  test("starts a task with no counter at 1, a number runIdOf takes", () => {
    expect(nextAfter(undefined, file)).toBe(1);
    expect(runIdOf("bpng", 1)).toBe("bpng-1");
  });

  test("counts on from the last number handed out", () => {
    expect(nextAfter(counterText(12), file)).toBe(13);
  });

  test("hands out the largest safe number, which runIdOf still takes", () => {
    const next = nextAfter(counterText(Number.MAX_SAFE_INTEGER - 1), file);
    expect(next).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => runIdOf("bpng", next)).not.toThrow();
  });

  for (const [why, text] of [
    ["empty", ""],
    ["not JSON", "{"],
    ["a number alone", "12"],
    ["null", "null"],
    ["a negative number", counterText(-3)],
    ["zero", counterText(0)],
    ["a fraction", counterText(1.5)],
    ["a string", counterText("12")],
    ["a number past the safe range", `{"v":1,"lastRun":9007199254740992}`],
    ["a number JSON reads as Infinity", `{"v":1,"lastRun":1e400}`],
    ["no number", `{"v":1}`],
    ["another version", `{"v":2,"lastRun":3}`],
    ["an unknown key", `{"v":1,"lastRun":3,"next":4}`],
  ] as const)
    test(`refuses a counter that is ${why}, naming the file — never a reset`, () => {
      expect(() => nextAfter(text, file)).toThrow(StateError);
      expect(() => nextAfter(text, file)).toThrow(file);
    });

  test("refuses a counter with no safe number left after it", () => {
    expect(() => nextAfter(counterText(Number.MAX_SAFE_INTEGER), file)).toThrow(
      /has no run number left/,
    );
  });
});

test.describe("nextRunNumber", () => {
  test("starts at 1, making the folder 0700 and the file 0600 under umask 0", async () => {
    const previous = process.umask(0);
    try {
      expect(await nextRunNumber(dir, "bpng")).toBe(1);
      expect((await stat(tasks)).mode & 0o777).toBe(0o700);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    } finally {
      process.umask(previous);
    }
  });

  test("saves each number as it hands it out, and counts on", async () => {
    for (const expected of [1, 2, 3]) {
      expect(await nextRunNumber(dir, "bpng")).toBe(expected);
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
        v: COUNTER_VERSION,
        lastRun: expected,
      });
    }
    expect(await readdir(tasks)).toEqual(["bpng.json"]);
  });

  test("keeps each task's count apart", async () => {
    await nextRunNumber(dir, "bpng");
    await nextRunNumber(dir, "bpng");
    expect(await nextRunNumber(dir, "fqhx")).toBe(1);
  });

  test("hands out no number when it cannot save it", async () => {
    await nextRunNumber(dir, "bpng");
    await chmod(tasks, 0o500);
    await expect(nextRunNumber(dir, "bpng")).rejects.toThrow();
    await chmod(tasks, 0o700);
    // The number it could not save was never used, so it is the next one handed out.
    expect(await nextRunNumber(dir, "bpng")).toBe(2);
  });

  test("refuses a corrupt counter, leaving it as it was", async () => {
    await mkdir(tasks);
    await writeFile(file, "{ broken");
    await expect(nextRunNumber(dir, "bpng")).rejects.toThrow(
      /run counter .*bpng\.json is not JSON/,
    );
    expect(await readFile(file, "utf8")).toBe("{ broken");
  });

  test("refuses a symbolic link at the counter's path, even to a valid counter, and leaves both", async () => {
    await mkdir(tasks);
    const elsewhere = join(dir, "elsewhere.json");
    await writeFile(elsewhere, counterText(5));
    await symlink(elsewhere, file);
    await expect(nextRunNumber(dir, "bpng")).rejects.toThrow(
      /is a symbolic link/,
    );
    expect(await readlink(file)).toBe(elsewhere);
    expect(await readFile(elsewhere, "utf8")).toBe(counterText(5));
  });

  test("refuses a folder at the counter's path", async () => {
    await mkdir(file, { recursive: true });
    await expect(nextRunNumber(dir, "bpng")).rejects.toThrow(
      /is not a regular file/,
    );
  });

  test("refuses a counter far larger than one", async () => {
    await mkdir(tasks);
    await writeFile(file, " ".repeat(4096) + counterText(3));
    await expect(nextRunNumber(dir, "bpng")).rejects.toThrow(/larger than/);
  });

  test("refuses a tasks folder that is a symbolic link, writing nothing through it", async () => {
    const elsewhere = join(dir, "elsewhere");
    await mkdir(elsewhere);
    await symlink(elsewhere, tasks);
    await expect(nextRunNumber(dir, "bpng")).rejects.toThrow(StateError);
    expect(await readdir(elsewhere)).toEqual([]);
  });

  test("refuses a tasks path that is a file", async () => {
    await writeFile(tasks, "");
    await expect(nextRunNumber(dir, "bpng")).rejects.toThrow(/is not a folder/);
  });

  test("refuses a task id that is not a task's before touching the disk", async () => {
    await expect(nextRunNumber(dir, "../bpng")).rejects.toThrow(RangeError);
    expect(await readdir(dir)).toEqual([]);
  });
});
