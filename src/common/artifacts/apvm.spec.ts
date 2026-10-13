import { test, expect } from "@playwright/test";

import { createBuildReporter, requiresToken } from "./apvm";

/** The APVM boundary's pure parts (masking its output is `text.ts`'s `redactSecrets`). */

test("requiresToken flags only the private-source projects", () => {
  expect(requiresToken("backwpup")).toBe(true);
  expect(requiresToken("wp-rocket")).toBe(false);
  expect(requiresToken("imagify")).toBe(false);
});

test.describe("createBuildReporter", () => {
  /** A GitHub-token-shaped string used across these cases; must never survive to the output. */
  const TOKEN = "ghp_16CharsOrMoreAAAA";

  test("scrubs the buffered output tail and the failure reason on the way out", () => {
    const reporter = createBuildReporter("plugin develop");
    reporter.onProgress(null, {
      type: "command_output",
      line: `Cloning https://x-access-token:${TOKEN}@github.com/wp-media/backwpup-pro.git`,
    });
    reporter.onProgress(null, {
      type: "build_failed",
      reason: `authentication failed using ${TOKEN}`,
    });

    const context = reporter.failureContext();
    expect(context).not.toContain(TOKEN);
    expect(context).not.toContain("x-access-token");
    // The diagnostically useful part survives.
    expect(context).toContain("github.com/wp-media/backwpup-pro.git");
    expect(context).toContain("authentication failed using ***");
  });

  test("retains only the trailing output window", () => {
    const reporter = createBuildReporter("plugin develop");
    for (let i = 0; i < 60; i += 1) {
      reporter.onProgress(null, {
        type: "command_output",
        line: `line-${String(i)}`,
      });
    }
    const context = reporter.failureContext();
    expect(context).toContain("line-59");
    expect(context).toContain("line-20"); // 60 - 40 = the oldest kept line
    expect(context).not.toContain("line-19");
  });

  test("is empty when nothing noteworthy happened, and ignores transport errors", () => {
    const reporter = createBuildReporter("plugin develop");
    reporter.onProgress(new Error("callback transport failure"), {
      type: "command_output",
      line: "must be ignored",
    });
    reporter.onProgress(null, { type: "step_started" });
    expect(reporter.failureContext()).toBe("");
  });
});
