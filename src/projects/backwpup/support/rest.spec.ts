import { test, expect } from "@playwright/test";

import {
  BACKWPUP_ROUTES,
  expectRestPayloadOk,
  matchesRoute,
  routeNamespace,
} from "./rest";
import type { Response } from "@playwright/test";

const BASE = "https://site.test";

test.describe("BackWPup REST route table", () => {
  test("holds the 25 name-addressable routes verified against the ref under test", () => {
    // 26 registrations at the ref; the 26th takes a path parameter and so has no name to match.
    expect(Object.keys(BACKWPUP_ROUTES)).toHaveLength(25);
  });

  test("records every route under one of the plugin's two namespaces", () => {
    for (const [route, namespace] of Object.entries(BACKWPUP_ROUTES)) {
      expect(namespace, `route "${route}"`).toMatch(/^backwpup\/v[12]$/);
    }
  });

  test("keeps the named v2 routes out of v1, where they could never match", () => {
    // Read off `register_rest_route()` at the ref under test: four registrations are v2, and these
    // are the three that have a fixed name (the fourth takes a path parameter and so is not
    // addressable here). Each sits among v1 neighbours, so assuming a single namespace silently
    // produces a barrier that can never fire.
    expect(routeNamespace("storages")).toBe("backwpup/v2");
    expect(routeNamespace("messages")).toBe("backwpup/v2");
    expect(routeNamespace("save_job_format")).toBe("backwpup/v2");
    expect(routeNamespace("startbackup")).toBe("backwpup/v1");
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
    // `messages` is a v2 route, so its URL carries v2 — the case that used to be written as v1 and
    // passed only because the matcher assumed the namespace it was given.
    expect(
      matchesRoute(`${BASE}/wp-json/backwpup/v2/messages/`, "messages"),
    ).toBe(true);
  });

  test("does not match a v2 route addressed under v1", () => {
    expect(
      matchesRoute(`${BASE}/wp-json/backwpup/v1/messages`, "messages"),
    ).toBe(false);
  });

  // A malformed percent-escape makes decodeURIComponent throw; the raw URL is then compared
  // instead, so a barrier still works rather than the helper blowing up mid-test.
  test("survives a malformed percent-escape", () => {
    expect(
      matchesRoute(`${BASE}/wp-json/backwpup/v1/backups?q=%E0%A4%A`, "backups"),
    ).toBe(true);
  });

  test("every declared route matches its own pretty URL, in its own namespace", () => {
    for (const route of Object.keys(
      BACKWPUP_ROUTES,
    ) as (keyof typeof BACKWPUP_ROUTES)[]) {
      expect(
        matchesRoute(
          `${BASE}/wp-json/${routeNamespace(route)}/${route}`,
          route,
        ),
        `route "${route}" should match its own URL`,
      ).toBe(true);
    }
  });
});

test.describe("expectRestPayloadOk", () => {
  /** A stand-in for the only part of a Playwright `Response` this reads. */
  const answering = (body: unknown): Response =>
    ({
      json: () =>
        body === undefined
          ? Promise.reject(new Error("not JSON"))
          : Promise.resolve(body),
    }) as unknown as Response;

  test("throws on the in-body failure the plugin sends with HTTP 200", async () => {
    // `startbackup` reports an unusable temp folder, log folder or destination exactly like this.
    await expect(
      expectRestPayloadOk(
        answering({
          status: 500,
          message: "The backup process could not be started!",
        }),
        "startbackup",
      ),
    ).rejects.toThrow(/could not be started/);
  });

  test("accepts both success shapes, including 201 for an already-finished job", async () => {
    // 201 means the run completed inside the plugin's own one-second wait — a success, and the
    // normal answer on a small site.
    await expect(
      expectRestPayloadOk(
        answering({ status: 200, message: 'Job "x" started.' }),
        "startbackup",
      ),
    ).resolves.toBeUndefined();
    await expect(
      expectRestPayloadOk(
        answering({ status: 201, message: 'Job "x" executed.' }),
        "startbackup",
      ),
    ).resolves.toBeUndefined();
  });

  test("passes bodies that do not use the convention, rather than inventing a failure", async () => {
    for (const body of [
      undefined,
      "plain text",
      [1, 2],
      { message: "no status here" },
    ]) {
      await expect(
        expectRestPayloadOk(answering(body), "backups"),
      ).resolves.toBeUndefined();
    }
  });
});
