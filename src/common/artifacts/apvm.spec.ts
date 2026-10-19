import { test, expect } from "@playwright/test";

import { createBuildReporter, redactBuildText, requiresToken } from "./apvm";

/** The APVM boundary's pure parts (masking by shape is `text.ts`'s `redactSecrets`). */

test("requiresToken flags only the private-source projects", () => {
  expect(requiresToken("backwpup")).toBe(true);
  expect(requiresToken("wp-rocket")).toBe(false);
  expect(requiresToken("imagify")).toBe(false);
});

test.describe("redactBuildText", () => {
  /** A legacy (pre-2021) GitHub token: 40 hex digits, the shape of any commit. */
  const LEGACY = "0123456789abcdef0123456789abcdef01234567";

  test("masks the process's GitHub tokens by value, keeping a commit of the same shape", () => {
    const saved = { gh: process.env.GITHUB_TOKEN, alt: process.env.GH_TOKEN };
    process.env.GITHUB_TOKEN = LEGACY;
    process.env.GH_TOKEN = "  ";
    try {
      const commit = "fedcba9876543210fedcba9876543210fedcba98";
      expect(
        redactBuildText(`token ${LEGACY} refused while fetching ${commit}`),
      ).toBe(`token *** refused while fetching ${commit}`);
      // Still masked by shape too.
      expect(redactBuildText("https://u:p@github.com/o/r.git")).toBe(
        "https://***@github.com/o/r.git",
      );
    } finally {
      for (const [name, value] of [
        ["GITHUB_TOKEN", saved.gh],
        ["GH_TOKEN", saved.alt],
      ] as const) {
        if (value === undefined) Reflect.deleteProperty(process.env, name);
        else process.env[name] = value;
      }
    }
  });
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
