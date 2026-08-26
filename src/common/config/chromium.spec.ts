import { test, expect, chromium } from "@playwright/test";
import { createRequire } from "node:module";

import {
  CAPTURED_FROM_PLAYWRIGHT,
  FRAME_REUSE_FEATURE,
  PLAYWRIGHT_DISABLED_FEATURES,
  VISIBLE_BROWSER_ENV,
  chromiumLaunchOptions,
  wantsVisibleBrowser,
} from "./chromium";

/**
 * The launch-argument override, and the two things that could quietly break it: a watched run being
 * read as unattended, and Playwright changing the default list this reproduces.
 */

/** The single `--disable-features` value the override produces, split back into feature names. */
function overriddenFeatures(): string[] {
  const { args } = chromiumLaunchOptions({ [VISIBLE_BROWSER_ENV]: "1" });
  expect(args, "the override should pass exactly one argument").toHaveLength(1);
  return (args?.[0] ?? "").replace("--disable-features=", "").split(",");
}

test.describe("wantsVisibleBrowser", () => {
  test("is true when the :headed / :ui scripts export the signal", () => {
    expect(wantsVisibleBrowser({ [VISIBLE_BROWSER_ENV]: "1" })).toBe(true);
  });

  // `--debug` exports PWDEBUG itself, so it needs no help from the npm scripts.
  test("is true under Playwright's own --debug", () => {
    expect(wantsVisibleBrowser({ PWDEBUG: "1" })).toBe(true);
    expect(wantsVisibleBrowser({ PWDEBUG: "console" })).toBe(true);
  });

  test("is false for an ordinary unattended run", () => {
    expect(wantsVisibleBrowser({})).toBe(false);
    expect(wantsVisibleBrowser({ CI: "true" })).toBe(false);
  });

  // The escape hatch: if enabling the feature ever misbehaves, this turns it off without giving up a
  // visible browser — and it must win over PWDEBUG too.
  test("an explicit 0 or false forces the override off", () => {
    for (const value of ["0", "false", "FALSE"]) {
      expect(
        wantsVisibleBrowser({ [VISIBLE_BROWSER_ENV]: value, PWDEBUG: "1" }),
        value,
      ).toBe(false);
    }
  });

  test("an empty value is ignored rather than read as off", () => {
    expect(
      wantsVisibleBrowser({ [VISIBLE_BROWSER_ENV]: "", PWDEBUG: "1" }),
    ).toBe(true);
    expect(wantsVisibleBrowser({ PWDEBUG: "" })).toBe(false);
  });
});

test.describe("chromiumLaunchOptions", () => {
  // The whole point of scoping it: an unattended run's command line must be exactly what Playwright
  // would have produced, so CI never carries the risk this override takes on.
  test("adds nothing at all to an unattended run", () => {
    expect(chromiumLaunchOptions({})).toEqual({});
  });

  test("re-enables the frame-reuse feature for a watched run", () => {
    expect(overriddenFeatures()).not.toContain(FRAME_REUSE_FEATURE);
  });

  // Chromium reads only the last `--disable-features`, so re-enabling one feature means re-stating
  // every other one. Dropping any would silently lose a protection Playwright added — `HttpsUpgrades`
  // alone would rewrite an `http://` docker site to `https://`.
  test("keeps every other feature Playwright disables, in order", () => {
    const kept = overriddenFeatures();
    expect(kept).toEqual(
      PLAYWRIGHT_DISABLED_FEATURES.filter(
        (feature) => feature !== FRAME_REUSE_FEATURE,
      ),
    );
    expect(kept, "one feature removed, the rest intact").toHaveLength(
      PLAYWRIGHT_DISABLED_FEATURES.length - 1,
    );
  });
});

/**
 * The drift guard, and the reason it launches a browser: {@link PLAYWRIGHT_DISABLED_FEATURES} is a
 * copy of a list **Playwright owns**, so comparing it against itself proves nothing. A version bump
 * can add a feature, and a feature added for a good reason would then be silently re-enabled in every
 * watched run. So this reads the list Playwright actually passes — off the browser process's own
 * argv, via `launchServer()`, which is the only place it is observable — and fails with an
 * instruction when the two diverge.
 */
test("the reproduced list matches the one Playwright really passes", async () => {
  const server = await chromium.launchServer({ headless: true });
  try {
    const argv = server.process().spawnargs;
    const flag = argv.find((arg) => arg.startsWith("--disable-features="));
    expect(
      flag,
      "Playwright should pass a --disable-features flag",
    ).toBeDefined();
    const live = (flag ?? "").replace("--disable-features=", "").split(",");
    const require = createRequire(import.meta.url);
    const { version } = require("playwright-core/package.json") as {
      version: string;
    };
    expect(
      live,
      `Playwright ${version} passes a different Chromium --disable-features list than the one ` +
        "PLAYWRIGHT_DISABLED_FEATURES reproduces. Update that constant (and CAPTURED_FROM_PLAYWRIGHT) " +
        "to the list above, then re-check that a watched run still paints after a navigation.",
    ).toEqual([...PLAYWRIGHT_DISABLED_FEATURES]);
    // Also recorded, so the constant's comment cannot rot even while the lists still agree.
    expect(version.startsWith(`${CAPTURED_FROM_PLAYWRIGHT}.`)).toBe(true);
  } finally {
    await server.close();
  }
});
