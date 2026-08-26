import { test, expect } from "@playwright/test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isOnboardingPending, readOnboardingFlag } from "./onboarding";
import type { LocalTransport } from "../../../common/config/types";

// A stub `wp` on PATH. `set` is what WordPress prints for the boolean `true` the plugin writes;
// `deleted` is WP-CLI's own wording once onboarding completes and the row is removed.
const STUB_WP = `#!/usr/bin/env bash
case "$WP_STUB_MODE" in
  set)      printf '1\\n' ;;
  deleted)  printf "Error: Could not get 'backwpup_onboarding' option. Does it exist?" >&2; exit 1 ;;
  broken)   printf 'Error: Error establishing a database connection.' >&2; exit 1 ;;
esac
exit 0
`;

let binDir: string;
let rootDir: string;
let originalPath: string | undefined;

test.beforeAll(() => {
  binDir = mkdtempSync(join(tmpdir(), "bwp-onb-stub-bin-"));
  rootDir = mkdtempSync(join(tmpdir(), "bwp-onb-stub-root-"));
  const wp = join(binDir, "wp");
  writeFileSync(wp, STUB_WP);
  chmodSync(wp, 0o755);
  originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
});

test.afterAll(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  rmSync(binDir, { recursive: true, force: true });
  rmSync(rootDir, { recursive: true, force: true });
});

const local = (): LocalTransport => ({ mode: "local", rootDir });

test.describe("readOnboardingFlag", () => {
  test("returns the value WordPress stores for the plugin's boolean", async () => {
    process.env.WP_STUB_MODE = "set";
    expect(await readOnboardingFlag(local())).toBe("1");
  });

  // Completing onboarding deletes the row rather than falsifying it, so absence is the normal
  // "already onboarded" state and must not read as an error.
  test("a site that completed onboarding has no option at all", async () => {
    process.env.WP_STUB_MODE = "deleted";
    expect(await readOnboardingFlag(local())).toBeUndefined();
  });

  test("a site that cannot answer throws rather than reading as onboarded", async () => {
    process.env.WP_STUB_MODE = "broken";
    await expect(readOnboardingFlag(local())).rejects.toThrow(
      /database connection/,
    );
  });
});

test.describe("isOnboardingPending", () => {
  test("the value the plugin writes means onboarding is still owed", () => {
    expect(isOnboardingPending("1")).toBe(true);
    expect(isOnboardingPending("1\n")).toBe(true);
  });

  test("an absent row means onboarding is done", () => {
    expect(isOnboardingPending(undefined)).toBe(false);
  });

  // WordPress stores `false` as an empty string, and a hand-set `0` is falsy to PHP as well; both
  // must read the way the plugin's own `get_site_option(..., false)` check would.
  test("a falsy value is read the way WordPress would read it", () => {
    expect(isOnboardingPending("")).toBe(false);
    expect(isOnboardingPending("0")).toBe(false);
  });
});
