import { test, expect } from "@playwright/test";

import {
  readRunDescription,
  reporterMode,
  type RunDescription,
} from "./run-description";

/**
 * The facts every own reporter receives, and the mode Playwright runs reporters in: a malformed
 * description is named, never thrown — a throwing reporter would fail the run.
 */

const RUN: RunDescription = {
  product: "backwpup",
  cell: "pro@nginx",
  edition: "pro",
  pinned: true,
  runId: "run-1",
  reportCell: "pro@nginx",
  reportDir: "reports/backwpup/pro@nginx/run-1",
  reportPath: "/repo/reports/backwpup/pro@nginx/run-1",
};

test.describe("readRunDescription", () => {
  test("takes a complete description, with the options Playwright adds", () => {
    const options = { ...RUN, configDir: "/repo", _mode: "test" };
    expect(readRunDescription(options)).toBe(options);
    const { cell: _cell, edition: _edition, ...everyCell } = RUN;
    expect(readRunDescription(everyCell)).toEqual(everyCell);
  });

  test("names the first field missing or of the wrong type", () => {
    const cases: [unknown, string][] = [
      [undefined, "product"],
      [{}, "product"],
      [{ ...RUN, reportPath: undefined }, "reportPath"],
      [{ ...RUN, runId: 42 }, "runId"],
      [{ ...RUN, cell: 1 }, "cell"],
      [{ ...RUN, edition: null }, "edition"],
      [{ ...RUN, pinned: "yes" }, "pinned"],
    ];
    for (const [options, field] of cases) {
      expect(readRunDescription(options), JSON.stringify(options)).toEqual({
        missing: field,
      });
    }
  });
});

test.describe("reporterMode", () => {
  test("list only for Playwright's list mode; test otherwise", () => {
    expect(reporterMode({ _mode: "list" })).toBe("list");
    for (const options of [
      { _mode: "test" },
      { _mode: "merge" },
      {},
      undefined,
      null,
      "x",
    ]) {
      expect(reporterMode(options), JSON.stringify(options)).toBe("test");
    }
  });
});
