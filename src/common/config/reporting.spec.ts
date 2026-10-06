import { test, expect } from "@playwright/test";

import { isObject } from "../guards";
import { reporters } from "./reporting";

/**
 * Where a run's three reports land. They must share one folder, whatever the working directory:
 * Playwright resolves its reporters' paths against the config's folder, while allure-playwright
 * resolves `resultsDir` against the working directory, so only an absolute folder keeps them
 * together.
 */

const REPORT_DIR =
  "/srv/checkout/reports/backwpup/pro@nginx/2026-10-06T00-00-00-000Z-1";

/** The options object of the reporter registered as `name`. */
function optionsOf(name: string): Record<string, unknown> {
  const entry = reporters(REPORT_DIR).find(([reporter]) => reporter === name);
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
      expect(() => reporters(relative), relative).toThrow(
        "[reporting] The report folder must be absolute",
      );
    }
  });
});
