import { test, expect } from "@playwright/test";

import { withinBudget } from "./deadline";

/** {@link withinBudget}: the work's outcome when it is in time, a named timeout when it is not. */

/** A promise settling after `ms`, with `value` or, when `error` is given, rejecting with it. */
function after<T>(ms: number, value: T, error?: Error): Promise<T> {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      if (error === undefined) resolve(value);
      else reject(error);
    }, ms);
  });
}

test.describe("withinBudget", () => {
  test("resolves with the work's value when it is in time", async () => {
    expect(await withinBudget(after(5, "done"), 1_000, "the step")).toBe(
      "done",
    );
  });

  test("rejects with the work's own error when it fails in time", async () => {
    await expect(
      withinBudget(after(5, "x", new Error("it broke")), 1_000, "the step"),
    ).rejects.toThrow("it broke");
  });

  test("rejects naming the step once the budget is spent", async () => {
    const started = Date.now();
    await expect(
      withinBudget(after(10_000, "late"), 50, "ending the saved session"),
    ).rejects.toThrow("ending the saved session had not finished after 0.05 s");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("a work rejecting after the budget raises no unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const listen = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", listen);
    try {
      await expect(
        withinBudget(after(30, "x", new Error("late failure")), 5, "the step"),
      ).rejects.toThrow("had not finished");
      // Past the work's own rejection, with a turn for the process to report it.
      await after(60, undefined);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", listen);
    }
  });
});
