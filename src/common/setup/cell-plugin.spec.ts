import { test, expect } from "@playwright/test";

import {
  CELL_PLUGIN_CHECK,
  blameCellPlugin,
  healFailedCheck,
  healedCheck,
  isSkippableSlug,
  reportedCheck,
} from "./cell-plugin";

const BROKEN = {
  slug: "backwpup-pro",
  error: 'Fatal error: Uncaught Error: Class "X" not found',
};

test.describe("isSkippableSlug", () => {
  test("accepts a plugin slug", () => {
    expect(isSkippableSlug("backwpup-pro")).toBe(true);
    expect(isSkippableSlug("wp_rocket.2")).toBe(true);
  });

  test("refuses what --skip-plugins would read as more than that one plugin, or no plugin", () => {
    for (const slug of ["a,b", "", ".", "..", "a/b", "a\\b"]) {
      expect(isSkippableSlug(slug), slug).toBe(false);
    }
  });
});

test.describe("blameCellPlugin", () => {
  test("names the first slug WordPress boots without, asking no further", async () => {
    const asked: string[] = [];
    const slug = await blameCellPlugin(["a", "b", "c"], (candidate) => {
      asked.push(candidate);
      return Promise.resolve(candidate !== "a");
    });
    expect(slug).toBe("b");
    expect(asked).toEqual(["a", "b"]);
  });

  test("blames none when skipping each does not help", async () => {
    expect(
      await blameCellPlugin(["a", "b"], () => Promise.resolve(false)),
    ).toBeUndefined();
  });

  test("never asks with a slug that is not skippable", async () => {
    const asked: string[] = [];
    const slug = await blameCellPlugin(["a,b", ".."], (candidate) => {
      asked.push(candidate);
      return Promise.resolve(true);
    });
    expect(slug).toBeUndefined();
    expect(asked).toEqual([]);
  });
});

test.describe("the verdicts", () => {
  test("a removal WordPress's own uninstall finished says so, and passes", () => {
    const check = healedCheck(BROKEN, undefined);
    expect(check).toEqual({
      name: CELL_PLUGIN_CHECK,
      ok: true,
      detail:
        `WordPress cannot boot with the cell's plugin "backwpup-pro" loaded (${BROKEN.error}), and ` +
        "boots without it: that copy is broken, so it was removed before logging in — its own " +
        "uninstall removed it. The next @plugin scenario installs it fresh.",
    });
  });

  test("a failed removal and a report-only verdict fail, with the way to remove it by hand", () => {
    const failed = healFailedCheck(BROKEN, "boom");
    const reported = reportedCheck(BROKEN);
    expect(failed.ok).toBe(false);
    expect(reported.ok).toBe(false);
    expect(failed.detail).toMatch(/, and removing it failed: boom$/);
    for (const check of [failed, reported]) {
      expect(check.hint).toContain(
        "`wp --skip-plugins plugin deactivate backwpup-pro`, then delete wp-content/plugins/backwpup-pro.",
      );
    }
    expect(reported.hint).toContain(
      "A suite run on this cell removes it before logging in",
    );
  });
});
