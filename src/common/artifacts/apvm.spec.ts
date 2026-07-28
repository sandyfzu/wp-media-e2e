import { test, expect } from "@playwright/test";

import { createBuildReporter, redactSecrets, requiresToken } from "./apvm";

/**
 * The APVM boundary's pure parts. `redactSecrets` is the security-relevant one: everything we
 * keep from a builder's output — progress lines, the buffered failure tail, the rejection
 * message — is printed to the console and embedded in the error a Playwright HTML/Allure report
 * stores, and CI publishes those. A private-repo build authenticates with a GitHub token, and
 * git echoes the authenticated remote URL in several of its failure messages, so the scrub is
 * what keeps a token out of a published report.
 */

test.describe("redactSecrets", () => {
  test("removes GitHub tokens in every issued prefix", () => {
    for (const token of [
      "ghp_16CharsOrMoreAAAA",
      "gho_16CharsOrMoreAAAA",
      "ghu_16CharsOrMoreAAAA",
      "ghs_16CharsOrMoreAAAA",
      "ghr_16CharsOrMoreAAAA",
      "github_pat_11ABCDEFG0aBcDeFgHiJkL",
    ]) {
      const redacted = redactSecrets(
        `fatal: bad credentials for ${token} here`,
      );
      expect(redacted).not.toContain(token);
      expect(redacted).toContain("***");
    }
  });

  test("strips URL credentials while keeping the scheme and host readable", () => {
    const line =
      "fatal: unable to access 'https://x-access-token:ghp_16CharsOrMoreAAAA@github.com/wp-media/backwpup-pro.git/'";
    const redacted = redactSecrets(line);
    expect(redacted).not.toContain("ghp_16CharsOrMoreAAAA");
    expect(redacted).not.toContain("x-access-token");
    expect(redacted).toContain(
      "https://***@github.com/wp-media/backwpup-pro.git",
    );
  });

  test("leaves ordinary build output untouched", () => {
    const line =
      "Cloning into 'backwpup-pro' from https://github.com/wp-media/backwpup-pro.git";
    expect(redactSecrets(line)).toBe(line);
  });

  test("is idempotent — the warm path scrubs at the call site and again at the funnel", () => {
    const once = redactSecrets(
      "fatal: unable to access 'https://x-access-token:ghp_16CharsOrMoreAAAA@github.com/o/r.git'",
    );
    expect(redactSecrets(once)).toBe(once);
  });
});

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
