import { test, expect } from "@playwright/test";

import {
  DESKTOP,
  DESKTOP_VIEWPORT,
  MOBILE,
  MOBILE_TAG,
  MOBILE_VIEWPORT,
  deviceForTags,
} from "./devices";

/**
 * The device profiles and the tag→profile decision. What matters is not the exact numbers but
 * the properties the `use` overrides depend on: a mobile profile must actually emulate a mobile
 * client (not merely be narrow), both profiles must keep the pinned viewport a preset upgrade
 * could otherwise change, and an untagged scenario must select nothing at all so the project
 * default survives.
 */

test.describe("profiles", () => {
  test("desktop pins the baseline viewport and stays a desktop client", () => {
    expect(DESKTOP.viewport).toEqual(DESKTOP_VIEWPORT);
    expect(DESKTOP.isMobile).toBeFalsy();
    expect(DESKTOP.hasTouch).toBeFalsy();
  });

  test("mobile pins its viewport and emulates a real mobile client", () => {
    // A bare narrow viewport would leave `wp_is_mobile()`, touch handlers and DPR-sensitive
    // markup on their desktop paths — the whole reason the profile comes from a device preset.
    expect(MOBILE.viewport).toEqual(MOBILE_VIEWPORT);
    expect(MOBILE.isMobile).toBe(true);
    expect(MOBILE.hasTouch).toBe(true);
    expect(MOBILE.deviceScaleFactor).toBeGreaterThan(1);
    expect(MOBILE.userAgent).toMatch(/Mobile/);
  });

  test("mobile is narrower than desktop", () => {
    expect(MOBILE.viewport.width).toBeLessThan(DESKTOP_VIEWPORT.width);
  });
});

test.describe("deviceForTags", () => {
  test("returns the mobile profile for a @mobile scenario", () => {
    expect(deviceForTags([MOBILE_TAG])).toBe(MOBILE);
    expect(deviceForTags(["@smoke", "@mobile", "@pro"])).toBe(MOBILE);
  });

  test("returns undefined without the tag, so the project default applies", () => {
    // `undefined` (not a desktop profile) is the contract: each `use` override falls through to
    // the value the project already resolved, whatever a future project sets it to.
    expect(deviceForTags([])).toBeUndefined();
    expect(deviceForTags(["@smoke", "@visual"])).toBeUndefined();
  });

  test("matches the tag exactly, not as a prefix or substring", () => {
    expect(deviceForTags(["@mobile-menu"])).toBeUndefined();
    expect(deviceForTags(["@notmobile"])).toBeUndefined();
  });
});
