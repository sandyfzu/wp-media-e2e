import { test, expect } from "@playwright/test";
import { open } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  judgeFlat,
  pruneMsPerFolder,
  takeSample,
  type Sample,
  type Tolerance,
} from "./soak";

/** No allowance at all: any growth fails. */
const STRICT: Tolerance = { listeners: 0, resources: 0, timeouts: 0, fds: 0 };

/**
 * A sample with ordinary measures, those given replaced.
 *
 * @param cycle - the runs so far.
 * @param given - the measures that differ.
 */
function sample(cycle: number, given: Partial<Sample> = {}): Sample {
  return {
    cycle,
    listeners: 3,
    resources: 4,
    timeouts: 2,
    fds: 20,
    heapMiB: 50,
    ...given,
  };
}

test.describe("judgeFlat", () => {
  test("flat measures pass, the heap never judged", () => {
    const samples = [0, 10, 20, 30].map((cycle) =>
      sample(cycle, { heapMiB: cycle * 10 }),
    );
    expect(judgeFlat(samples, 1, STRICT)).toEqual([]);
  });

  test("a value back within the warm-up's spread passes", () => {
    const samples = [
      sample(0, { fds: 20 }),
      sample(10, { fds: 23 }),
      sample(20, { fds: 21 }),
      sample(30, { fds: 23 }),
    ];
    expect(judgeFlat(samples, 2, STRICT)).toEqual([]);
  });

  test("growth past the tolerance fails, naming the measure and the first sample over", () => {
    const samples = [
      sample(0),
      sample(10, { fds: 22 }),
      sample(20, { fds: 23 }),
      sample(30, { fds: 25 }),
    ];
    expect(judgeFlat(samples, 1, { ...STRICT, fds: 2 })).toEqual([
      "fds grew: 23 after 20 runs, over the warm-up's bound of 22",
    ]);
  });

  test("a slow leak — one per sample — fails once past the tolerance", () => {
    const samples = Array.from({ length: 20 }, (_, i) =>
      sample(i * 10, { listeners: 3 + i }),
    );
    const failures = judgeFlat(samples, 5, { ...STRICT, listeners: 2 });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("listeners grew: 10 after 70 runs");
  });

  test("every measure that grew is named", () => {
    const samples = [sample(0), sample(10, { resources: 5, timeouts: 3 })];
    expect(judgeFlat(samples, 1, STRICT)).toHaveLength(2);
  });

  test("a warm-up that leaves nothing to judge, or none at all, is refused", () => {
    const samples = [sample(0), sample(10)];
    expect(() => judgeFlat(samples, 2, STRICT)).toThrow(RangeError);
    expect(() => judgeFlat(samples, 0, STRICT)).toThrow(RangeError);
    expect(() => judgeFlat(samples, 1.5, STRICT)).toThrow(RangeError);
  });
});

test.describe("pruneMsPerFolder", () => {
  test("the median rate of the last prunings, one slow call aside", () => {
    const timings = [
      { folders: 10, ms: 100 }, // not among the last three
      { folders: 100, ms: 10 },
      { folders: 200, ms: 400 }, // a slow one
      { folders: 300, ms: 30 },
    ];
    expect(pruneMsPerFolder(timings, 3)).toBeCloseTo(0.1);
  });

  test("an even count takes the mean of the two middle rates", () => {
    expect(
      pruneMsPerFolder(
        [
          { folders: 10, ms: 1 },
          { folders: 10, ms: 3 },
        ],
        2,
      ),
    ).toBeCloseTo(0.2);
  });

  test("too few prunings, or one with no folder, are refused", () => {
    expect(() => pruneMsPerFolder([{ folders: 1, ms: 1 }], 2)).toThrow(
      RangeError,
    );
    expect(() => pruneMsPerFolder([{ folders: 0, ms: 1 }], 1)).toThrow(
      RangeError,
    );
    expect(() => pruneMsPerFolder([], 0)).toThrow(RangeError);
  });
});

test.describe("takeSample", () => {
  test("counts a listener, a timer and a descriptor this process gains", async () => {
    const before = takeSample(0);
    const listener = (): void => undefined;
    process.on("warning", listener);
    const timer = setTimeout(() => undefined, 60_000);
    const handle = await open(fileURLToPath(import.meta.url), "r");
    try {
      const after = takeSample(1);
      expect(after.cycle).toBe(1);
      expect(after.listeners).toBe(before.listeners + 1);
      expect(after.timeouts).toBe(before.timeouts + 1);
      expect(after.fds).toBe(before.fds + 1);
    } finally {
      await handle.close();
      clearTimeout(timer);
      process.off("warning", listener);
    }
  });
});
