import { test, expect } from "@playwright/test";

import { BACKWPUP_ROUTES, REST_NAMESPACE, matchesRoute } from "./rest";

const BASE = "https://site.test";

test.describe("BackWPup REST route table", () => {
  test("holds the 24 routes verified against the ref under test, with no duplicates", () => {
    expect(BACKWPUP_ROUTES).toHaveLength(24);
    expect(new Set(BACKWPUP_ROUTES).size).toBe(24);
  });

  test("uses the plugin's single namespace", () => {
    expect(REST_NAMESPACE).toBe("backwpup/v1");
  });
});

test.describe("matchesRoute — URL shapes WordPress actually serves", () => {
  test("matches the pretty permalink form", () => {
    expect(
      matchesRoute(`${BASE}/wp-json/backwpup/v1/startbackup`, "startbackup"),
    ).toBe(true);
  });

  test("matches the pretty form with a query string", () => {
    expect(
      matchesRoute(`${BASE}/wp-json/backwpup/v1/backups?page=2`, "backups"),
    ).toBe(true);
  });

  // A site without pretty permalinks serves REST via ?rest_route=, whose slashes arrive
  // percent-encoded. Both forms must satisfy the same barrier, since which one is used is a
  // property of the site's permalink settings and not of the test.
  test("matches the ?rest_route= form with encoded slashes", () => {
    expect(
      matchesRoute(
        `${BASE}/?rest_route=%2Fbackwpup%2Fv1%2Fstartbackup`,
        "startbackup",
      ),
    ).toBe(true);
  });

  test("matches the ?rest_route= form with further parameters", () => {
    expect(
      matchesRoute(
        `${BASE}/?rest_route=%2Fbackwpup%2Fv1%2Fbackups&page=3`,
        "backups",
      ),
    ).toBe(true);
  });

  test("does not match a different route", () => {
    expect(
      matchesRoute(`${BASE}/wp-json/backwpup/v1/getblock`, "startbackup"),
    ).toBe(false);
  });

  test("does not match another plugin's namespace", () => {
    expect(
      matchesRoute(`${BASE}/wp-json/other/v1/startbackup`, "startbackup"),
    ).toBe(false);
  });

  // The boundary anchor is the point of the whole function: without it a barrier on a short route
  // would also fire for any longer route sharing its prefix, resolving on the wrong call and
  // reporting an action complete that never happened.
  test("does not match a longer route that merely starts with this one", () => {
    expect(
      matchesRoute(`${BASE}/wp-json/backwpup/v1/backups-extended`, "backups"),
    ).toBe(false);
    expect(
      matchesRoute(
        `${BASE}/wp-json/backwpup/v1/save_job_settings_extra`,
        "save_job_settings",
      ),
    ).toBe(false);
  });

  test("matches a route followed by a trailing slash", () => {
    expect(
      matchesRoute(`${BASE}/wp-json/backwpup/v1/messages/`, "messages"),
    ).toBe(true);
  });

  // A malformed percent-escape makes decodeURIComponent throw; the raw URL is then compared
  // instead, so a barrier still works rather than the helper blowing up mid-test.
  test("survives a malformed percent-escape", () => {
    expect(
      matchesRoute(`${BASE}/wp-json/backwpup/v1/backups?q=%E0%A4%A`, "backups"),
    ).toBe(true);
  });

  test("every declared route matches its own pretty URL", () => {
    for (const route of BACKWPUP_ROUTES) {
      expect(
        matchesRoute(`${BASE}/wp-json/${REST_NAMESPACE}/${route}`, route),
        `route "${route}" should match its own URL`,
      ).toBe(true);
    }
  });
});
