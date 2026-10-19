import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  BOOT_PARENT_PID,
  PARENT_WATCH_MS,
  parentGone,
  runByNpm,
  watchParent,
} from "./parent";

/** The parent watch: the rule, the reader, and when the baseline is read. */

/** The process's referenced timers: what keeps it alive. */
function referencedTimeouts(): number {
  return process
    .getActiveResourcesInfo()
    .filter((resource) => resource === "Timeout").length;
}

test.describe("parentGone", () => {
  test("a parent other than the boot's is gone, under npm or not; the boot's is not", () => {
    for (const underNpm of [false, true]) {
      expect(parentGone(100, 1, underNpm)).toBe(
        "the parent process 100 ended (now 1)",
      );
      expect(parentGone(100, 4321, underNpm)).toBe(
        "the parent process 100 ended (now 4321)",
      );
      expect(parentGone(100, 100, underNpm)).toBeUndefined();
    }
  });

  test("PID 1 from boot is npm gone under npm only: npm runs the script as its own child", () => {
    expect(parentGone(1, 1, true)).toBe(
      "npm, the parent process, ended before the orchestrator started (its parent is PID 1)",
    );
    expect(parentGone(1, 1, false)).toBeUndefined();
  });
});

test.describe("runByNpm", () => {
  test("npm's script variable, set and not empty, is npm", () => {
    expect(runByNpm({ npm_lifecycle_event: "orchestrator" })).toBe(true);
    expect(runByNpm({ npm_lifecycle_event: "" })).toBe(false);
    expect(runByNpm({ npm_execpath: "/npm-cli.js" })).toBe(false);
    expect(runByNpm({})).toBe(false);
  });
});

test.describe("watchParent", () => {
  test("a parent already gone is told before it returns, once, and nothing is left to watch", async () => {
    const told: string[] = [];
    let reads = 0;
    const before = referencedTimeouts();
    const stop = watchParent(
      {
        parentPid: () => {
          reads += 1;
          return 1;
        },
        bootParentPid: 100,
        intervalMs: 10,
      },
      false,
      (why) => told.push(why),
    );
    expect(told).toEqual(["the parent process 100 ended (now 1)"]);
    await delay(50);
    expect(reads).toBe(1);
    expect(told).toHaveLength(1);
    expect(referencedTimeouts()).toBe(before);
    stop();
  });

  test("a parent that ends later is told once, then no longer read", async () => {
    const told: string[] = [];
    let parent = 100;
    let reads = 0;
    const stop = watchParent(
      {
        parentPid: () => {
          reads += 1;
          return parent;
        },
        bootParentPid: 100,
        intervalMs: 10,
      },
      false,
      (why) => told.push(why),
    );
    await delay(50);
    expect(told).toEqual([]);
    parent = 4321;
    await expect.poll(() => told.length).toBe(1);
    const count = reads;
    await delay(50);
    expect(reads).toBe(count);
    expect(told).toEqual(["the parent process 100 ended (now 4321)"]);
    stop();
  });

  test("never keeps the process alive by itself, and stops when asked", async () => {
    let reads = 0;
    const before = referencedTimeouts();
    const stop = watchParent(
      {
        parentPid: () => {
          reads += 1;
          return 7;
        },
        bootParentPid: 7,
        intervalMs: 10,
      },
      false,
      () => undefined,
    );
    // Armed, but unreferenced: the count of what keeps the process alive is unchanged.
    expect(referencedTimeouts()).toBe(before);
    await expect.poll(() => reads).toBeGreaterThan(2);
    stop();
    stop();
    const count = reads;
    await delay(50);
    expect(reads).toBe(count);
  });

  test("by default, the boot's parent and the parent now are this process's: alive, nothing told", () => {
    const told: string[] = [];
    const stop = watchParent({}, false, (why) => told.push(why));
    stop();
    expect(told).toEqual([]);
    expect(BOOT_PARENT_PID).toBe(process.ppid);
    expect(PARENT_WATCH_MS).toBe(1_000);
  });

  test("the command imports it first, so the boot's parent is read before the rest of the module graph", () => {
    const source = readFileSync(
      join(import.meta.dirname, "command.ts"),
      "utf8",
    );
    const first = /^import\s[^;]*;/m.exec(source)?.[0];
    expect(first).toBe('import "./parent";');
  });
});
