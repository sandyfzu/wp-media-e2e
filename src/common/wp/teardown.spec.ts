import { test, expect } from "@playwright/test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_STAGING_DIR,
  PLUGINS_CATEGORY,
  stageArtifact,
} from "./staging";
import { releaseSite } from "./teardown";
import type { SiteConfig } from "../config/types";

/**
 * Worker teardown, exercised on the `local` transport against a real WP-root-like directory.
 * The three properties that matter: a real site's staging area is actually removed, a
 * placeholder site is never touched (a fresh checkout must not warn on every run), and a
 * cleanup failure is reported without being thrown — teardown runs after every assertion, so it
 * can never be allowed to fail a passing run.
 */

let wpRoot: string;
let sourceDir: string;
let warnings: string[];
let realWarn: typeof console.warn;

/** True when the suite runs as root, which bypasses the permission bits one case relies on. */
const isRoot = process.getuid?.() === 0;

/** A `local` site rooted at the temp WordPress root. */
function localSite(baseURL = "https://real.example.com"): SiteConfig {
  return {
    baseURL,
    username: "admin",
    password: "secret",
    transport: { mode: "local", rootDir: wpRoot },
    storageState: join(wpRoot, "state.json"),
  };
}

test.beforeEach(() => {
  wpRoot = mkdtempSync(join(tmpdir(), "wp-teardown-root-"));
  sourceDir = mkdtempSync(join(tmpdir(), "wp-teardown-src-"));
  warnings = [];
  realWarn = console.warn;
  console.warn = (...args: unknown[]): void => {
    warnings.push(args.map((arg) => String(arg)).join(" "));
  };
});

test.afterEach(() => {
  console.warn = realWarn;
  for (const dir of [wpRoot, sourceDir]) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Stages one file into the site's area and returns the area's root. */
async function stageSomething(site: SiteConfig): Promise<string> {
  const source = join(sourceDir, "plugin.zip");
  writeFileSync(source, "zip bytes");
  await stageArtifact(site.transport, source, { category: PLUGINS_CATEGORY });
  return join(wpRoot, DEFAULT_STAGING_DIR);
}

test("removes the bound site's staging area", async () => {
  const site = localSite();
  const staging = await stageSomething(site);
  expect(existsSync(staging)).toBe(true);

  await releaseSite(site);

  expect(existsSync(staging)).toBe(false);
  expect(warnings).toEqual([]);
});

test("is a no-op when nothing was ever staged", async () => {
  await expect(releaseSite(localSite())).resolves.toBeUndefined();
  expect(warnings).toEqual([]);
});

test("skips a placeholder site instead of failing against an unreachable transport", async () => {
  // A fresh checkout runs on `sites.example.json`; teardown must stay silent there.
  const placeholder: SiteConfig = {
    ...localSite("https://backwpup.pro-nginx.example.test"),
    transport: {
      mode: "ssh",
      host: "203.0.113.21",
      username: "ubuntu",
      privateKeyPath: "/nope",
      rootDir: "/var/www/html/x",
    },
  };
  await expect(releaseSite(placeholder)).resolves.toBeUndefined();
  expect(warnings).toEqual([]);
});

test("does nothing but dispose when the project has no pool", async () => {
  await expect(releaseSite(undefined)).resolves.toBeUndefined();
  expect(warnings).toEqual([]);
});

test("warns instead of throwing when the removal genuinely fails", async () => {
  test.skip(
    isRoot,
    "root ignores directory permissions, so rm -rf would succeed",
  );
  const site = localSite();
  const staging = await stageSomething(site);
  // A file cannot be unlinked from a read-only parent, so `rm -rf` exits non-zero.
  chmodSync(staging, 0o500);
  // Unprivileged on purpose: cleanup escalates when it can, so allowing it here would make the
  // result depend on whether this machine has passwordless sudo (CI does).
  const unprivileged: SiteConfig = {
    ...site,
    transport: { ...site.transport, elevate: false },
  };
  try {
    await expect(releaseSite(unprivileged)).resolves.toBeUndefined();
    expect(warnings.join("\n")).toMatch(
      /could not clean the staging area on https:\/\/real\.example\.com \(continuing\)/,
    );
  } finally {
    if (existsSync(staging)) chmodSync(staging, 0o700);
  }
});
