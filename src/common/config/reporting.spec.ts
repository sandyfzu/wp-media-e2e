import { test, expect } from "@playwright/test";
import { isAbsolute } from "node:path";

import { isObject } from "../guards";
import type { RunDescription } from "../reporting/run-description";
import { reporters } from "./reporting";

/**
 * Where a run's three reports land. They must share one folder, whatever the working directory:
 * Playwright resolves its reporters' paths against the config's folder, while allure-playwright
 * resolves `resultsDir` against the working directory, so only an absolute folder keeps them
 * together. The cell notice must come first, so it prints before `list`'s "Running …"; the results
 * stream before the reports, so its last line is not held up by their `onEnd`; the summary last, so
 * it is the run's final block.
 */

const REPORT_DIR =
  "/srv/checkout/reports/backwpup/pro@nginx/2026-10-06T00-00-00-000Z-1";

const RUN: RunDescription = {
  product: "backwpup",
  cell: "pro@nginx",
  edition: "pro",
  pinned: true,
  runId: "2026-10-06T00-00-00-000Z-1",
  reportCell: "pro@nginx",
  reportDir: "reports/backwpup/pro@nginx/2026-10-06T00-00-00-000Z-1",
  reportPath: REPORT_DIR,
};

/** The run with another report path. */
function withPath(reportPath: string): RunDescription {
  return { ...RUN, reportPath };
}

/** The options object of the reporter registered as `name`. */
function optionsOf(name: string): Record<string, unknown> {
  const entry = reporters(RUN).find(([reporter]) => reporter === name);
  const options: unknown = entry?.[1];
  if (!isObject(options)) throw new Error(`no options for reporter ${name}`);
  return options;
}

test.describe("reporters — one folder per run, wherever the run starts", () => {
  test("puts each report under the absolute folder it is given", () => {
    expect(optionsOf("html").outputFolder).toBe(`${REPORT_DIR}/playwright`);
    expect(optionsOf("playwright-bdd/reporter/cucumber").outputFile).toBe(
      `${REPORT_DIR}/cucumber/index.html`,
    );
    expect(optionsOf("allure-playwright").resultsDir).toBe(
      `${REPORT_DIR}/allure-results`,
    );
  });

  test("refuses a relative folder, which would send Allure's results to the working directory", () => {
    for (const relative of [
      "reports/backwpup/pro@nginx/run",
      "./reports",
      "",
    ]) {
      expect(() => reporters(withPath(relative)), relative).toThrow(
        "[reporting] The report folder must be absolute",
      );
    }
  });
});

test.describe("reporters — the cell notice", () => {
  test("comes first, before list, from an absolute path, with the facts it is given", () => {
    const list = reporters(RUN);
    const [first] = list;
    expect(first?.[0]).toMatch(/\/src\/common\/reporting\/cell-notice\.ts$/);
    expect(isAbsolute(first?.[0] ?? "")).toBe(true);
    expect(first?.[1]).toEqual(RUN);
    expect(list.findIndex(([name]) => name === "list")).toBeGreaterThan(0);
  });
});

test.describe("reporters — the results stream and the summary", () => {
  test("the stream comes before the reports, the summary last, each from an absolute path with the run's facts", () => {
    const list = reporters(RUN);
    const names = list.map(([name]) => name);
    const own = (file: string): number =>
      names.findIndex((name) => name.endsWith(`/src/common/reporting/${file}`));
    const stream = own("results-stream.ts");
    const summary = own("run-summary.ts");

    // Before `list` and every report, so `run.end` is written before their slow `onEnd`.
    expect(stream).toBe(1);
    expect(names[stream + 1]).toBe("list");
    // Last, so its `onExit` prints below everything else.
    expect(summary).toBe(list.length - 1);
    for (const index of [stream, summary]) {
      expect(isAbsolute(names[index] ?? "")).toBe(true);
      expect(list[index]?.[1]).toEqual(RUN);
    }
  });
});
