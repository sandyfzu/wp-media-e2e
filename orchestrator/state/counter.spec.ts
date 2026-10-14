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

import { runIdOf, RUNS_DIR } from "../runs/identity";
import {
  COUNTER_VERSION,
  counterPath,
  highestRunFolder,
  nextAfter,
  nextRunNumber,
  TASKS_DIR,
  type CounterPlace,
} from "./counter";
import { StateError } from "./errors";

/** A fresh state directory per test, removed after it. */
let dir: string;
let tasks: string;
let file: string;
let runs: string;
let place: CounterPlace;
test.beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "e2e-counter-"));
  tasks = join(dir, TASKS_DIR);
  file = join(tasks, "bpng.json");
  runs = join(dir, RUNS_DIR);
  place = { path: file, taskId: "bpng", runsDir: runs };
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
  test("starts a task with no counter and no run folder at 1, a number runIdOf takes", () => {
    expect(nextAfter(undefined, 0, place)).toBe(1);
    expect(runIdOf("bpng", 1)).toBe("bpng-1");
  });

  test("counts on from the last number handed out", () => {
    expect(nextAfter(counterText(12), 0, place)).toBe(13);
  });

  test("counts on past the highest run folder when there is no counter", () => {
    expect(nextAfter(undefined, 40, place)).toBe(41);
  });

  test("counts on past whichever is higher, the counter or the run folders", () => {
    expect(nextAfter(counterText(12), 40, place)).toBe(41);
    expect(nextAfter(counterText(40), 12, place)).toBe(41);
  });

  test("takes a counter set to 0, the repair recipe's value for a task with no run yet", () => {
    expect(nextAfter(counterText(0), 0, place)).toBe(1);
  });

  test("reads a counter saved with a byte-order mark, as the config's loader does", () => {
    expect(nextAfter(`\uFEFF${counterText(12)}`, 0, place)).toBe(13);
  });

  test("hands out the largest safe number, which runIdOf still takes", () => {
    const next = nextAfter(counterText(Number.MAX_SAFE_INTEGER - 1), 0, place);
    expect(next).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => runIdOf("bpng", next)).not.toThrow();
  });

  for (const [why, text] of [
    ["empty", ""],
    ["not JSON", "{"],
    ["a number alone", "12"],
    ["null", "null"],
    ["a negative number", counterText(-3)],
    ["two byte-order marks", `\uFEFF\uFEFF${counterText(3)}`],
    ["a fraction", counterText(1.5)],
    ["a string", counterText("12")],
    ["a number past the safe range", `{"v":1,"lastRun":9007199254740992}`],
    ["a number JSON reads as Infinity", `{"v":1,"lastRun":1e400}`],
    ["no number", `{"v":1}`],
    ["another version", `{"v":2,"lastRun":3}`],
    ["an unknown key", `{"v":1,"lastRun":3,"next":4}`],
  ] as const)
    test(`refuses a counter that is ${why}, naming the file — never a reset`, () => {
      expect(() => nextAfter(text, 0, place)).toThrow(StateError);
      expect(() => nextAfter(text, 0, place)).toThrow(file);
    });

  test("refuses a counter, or run folders, with no safe number left after them", () => {
    expect(() =>
      nextAfter(counterText(Number.MAX_SAFE_INTEGER), 0, place),
    ).toThrow(/has no run number left/);
    expect(() => nextAfter(undefined, Number.MAX_SAFE_INTEGER, place)).toThrow(
      /has no run number left/,
    );
  });

  test("words the repair with the task's own id and run folders, never a placeholder for them", () => {
    let message = "";
    try {
      nextAfter("{", 0, place);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe(
      `The run counter ${file} is not JSON. It is never reset on its own, since a reset reuses run numbers. Remove it to count on from the highest of ${join(runs, "bpng-<n>")}/ (a pruned run's number is not seen there): rm ${file} — or set it to {"v":1,"lastRun":<n>}, n the highest number task bpng has used (0 for none).`,
    );
    expect(message).not.toContain("<task>");
  });
});

test.describe("highestRunFolder", () => {
  test("is 0 with no runs/ folder, or none of the task's", async () => {
    expect(await highestRunFolder(runs, "bpng")).toBe(0);
    await mkdir(join(runs, "fqhx-9"), { recursive: true });
    expect(await highestRunFolder(runs, "bpng")).toBe(0);
  });

  test("is the highest name that is exactly one of the task's run ids, whatever the entry is", async () => {
    await mkdir(join(runs, "bpng-7"), { recursive: true });
    // A file or a link under a run's name still holds that number: it is never handed out again.
    await writeFile(join(runs, "bpng-9"), "");
    await symlink(join(dir, "nowhere"), join(runs, "bpng-12"));
    // Not the task's run ids.
    for (const name of [
      "bpng-0120",
      "bpng-012",
      "bpngx-50",
      "fqhx-99",
      ".pruning-1-2-abcdef01",
    ])
      await mkdir(join(runs, name));
    expect(await highestRunFolder(runs, "bpng")).toBe(12);
  });

  test("refuses a runs/ that is a link or a file, naming it", async () => {
    const elsewhere = join(dir, "elsewhere");
    await mkdir(join(elsewhere, "bpng-3"), { recursive: true });
    await symlink(elsewhere, runs);
    await expect(highestRunFolder(runs, "bpng")).rejects.toThrow(StateError);
    await rm(runs);
    await writeFile(runs, "");
    await expect(highestRunFolder(runs, "bpng")).rejects.toThrow(
      /run folders' folder .* is not a folder/,
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

  test("seeds a missing counter from the task's run folders, never restarting at 1 under them", async () => {
    await mkdir(join(runs, "bpng-40"), { recursive: true });
    await mkdir(join(runs, "fqhx-90"));
    expect(await nextRunNumber(dir, "bpng")).toBe(41);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      v: COUNTER_VERSION,
      lastRun: 41,
    });
    expect(await nextRunNumber(dir, "fqhx")).toBe(91);
  });

  test("counts past a run folder its counter is behind", async () => {
    await nextRunNumber(dir, "bpng");
    await mkdir(join(runs, "bpng-5"), { recursive: true });
    expect(await nextRunNumber(dir, "bpng")).toBe(6);
  });

  test("refuses a dangling symbolic link at tasks/, naming it", async () => {
    await symlink(join(dir, "nowhere"), tasks);
    await expect(nextRunNumber(dir, "bpng")).rejects.toThrow(
      /run counters' folder .*tasks is not a folder \(a symbolic link is refused\)/,
    );
    expect(await readdir(dir)).toEqual([TASKS_DIR]);
  });

  for (const mode of [0o755, 0o750, 0o777])
    test(`refuses a tasks/ folder of mode ${mode.toString(8)}, open to others`, async () => {
      await mkdir(tasks, { mode: 0o700 });
      await chmod(tasks, mode);
      await expect(nextRunNumber(dir, "bpng")).rejects.toThrow(
        `The run counters' folder ${tasks} is mode ${mode.toString(8)}: it must be this user's alone (chmod 700 ${tasks}).`,
      );
      expect(await readdir(tasks)).toEqual([]);
    });

  test("refuses a corrupt counter, leaving it as it was", async () => {
    await mkdir(tasks, { mode: 0o700 });
    await writeFile(file, "{ broken");
    await expect(nextRunNumber(dir, "bpng")).rejects.toThrow(
      /run counter .*bpng\.json is not JSON/,
    );
    expect(await readFile(file, "utf8")).toBe("{ broken");
  });

  test("refuses a symbolic link at the counter's path, even to a valid counter, and leaves both", async () => {
    await mkdir(tasks, { mode: 0o700 });
    const elsewhere = join(dir, "elsewhere.json");
    await writeFile(elsewhere, counterText(5));
    await symlink(elsewhere, file);
    await expect(nextRunNumber(dir, "bpng")).rejects.toThrow(
      /is a symbolic link: .* never reset on its own.*rm /,
    );
    expect(await readlink(file)).toBe(elsewhere);
    expect(await readFile(elsewhere, "utf8")).toBe(counterText(5));
  });

  test("refuses a folder at the counter's path", async () => {
    await mkdir(file, { recursive: true, mode: 0o700 });
    await expect(nextRunNumber(dir, "bpng")).rejects.toThrow(
      /is not a regular file/,
    );
  });

  test("refuses a counter far larger than one", async () => {
    await mkdir(tasks, { mode: 0o700 });
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
