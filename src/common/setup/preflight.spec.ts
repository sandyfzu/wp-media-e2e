import { test, expect } from "@playwright/test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { verifyPool } from "./preflight";
import type { SiteConfig } from "../config/types";

// A stub `wp` on PATH exercises the real exec layer + preflight with deterministic exit codes —
// no WordPress, no database. Behaviour is chosen per test via two env vars:
//   $WP_STUB_INFO       fail                     → `wp --info` exits 1 (WP-CLI "missing")
//   $WP_STUB_INSTALLED  no | nowp | phpold | *   → `wp core is-installed`:
//        no     → exit 1, silent            (genuinely not installed — tables missing)
//        nowp   → exit 1, stderr "Error…"   (target is not a WordPress directory)
//        phpold → exit 1, stdout PHP error  (installed, but PHP too old to boot — core printf()s
//                                            to STDOUT and exit(1); the historical false negative)
//        *      → exit 0                     (installed)
//   $WP_STUB_LOCALE     <locale> | fail | *  → `wp eval 'echo determine_locale();'`:
//        fail   → exit 1                    (could not be evaluated)
//        unset  → en_US                     (the English default)
//        other  → that locale               (e.g. fr_FR, to exercise the failure path)
const STUB_WP = `#!/usr/bin/env bash
if [ "$1" = "--info" ]; then
  [ "$WP_STUB_INFO" = "fail" ] && { echo "wp: not found" >&2; exit 1; }
  echo "WP-CLI version: 2.10.0"
  exit 0
fi
if [ "$1 $2" = "core is-installed" ]; then
  case "$WP_STUB_INSTALLED" in
    no)     exit 1 ;;
    nowp)   echo "Error: This does not seem to be a WordPress installation." >&2; exit 1 ;;
    phpold) echo "Your server is running PHP version 7.3.33 but WordPress 7.0 requires at least 7.4."; exit 1 ;;
    *)      exit 0 ;;
  esac
fi
if [ "$1" = "eval" ]; then
  [ "$WP_STUB_LOCALE" = "fail" ] && exit 1
  printf '%s' "\${WP_STUB_LOCALE:-en_US}"
  exit 0
fi
exit 0
`;

let stubDir: string;
let wpRoot: string;
let originalPath: string;

/** A real, non-placeholder local site pointing `wp` at `wpRoot`. */
function localSite(baseURL = "http://localhost:8100"): SiteConfig {
  return {
    baseURL,
    username: "admin",
    password: "admin_password",
    transport: { mode: "local", rootDir: wpRoot },
    storageState: join(wpRoot, "state.json"),
  };
}

test.beforeAll(() => {
  stubDir = mkdtempSync(join(tmpdir(), "wp-stub-"));
  writeFileSync(join(stubDir, "wp"), STUB_WP);
  chmodSync(join(stubDir, "wp"), 0o755);
  // A real directory so the rootDir check passes; the stub ignores its contents.
  wpRoot = mkdtempSync(join(tmpdir(), "wp-root-"));
  originalPath = process.env.PATH ?? "";
  process.env.PATH = `${stubDir}:${originalPath}`;
});

test.afterAll(() => {
  process.env.PATH = originalPath;
  delete process.env.WP_STUB_INFO;
  delete process.env.WP_STUB_INSTALLED;
  delete process.env.WP_STUB_LOCALE;
  rmSync(stubDir, { recursive: true, force: true });
  rmSync(wpRoot, { recursive: true, force: true });
});

// The locale gate protects every role/label locator in the suite: a translated admin would otherwise
// surface as dozens of indistinguishable locator timeouts instead of one named failure here.
test.describe("verifyPool — admin locale gate", () => {
  test.beforeEach(() => {
    delete process.env.WP_STUB_INFO;
    process.env.WP_STUB_INSTALLED = "yes";
  });

  // Cleared after every test in this block: the other describes share the process and know nothing
  // about this variable, so a leaked non-English locale would fail them for the wrong reason.
  test.afterEach(() => {
    delete process.env.WP_STUB_LOCALE;
  });

  test("passes on the English default", async () => {
    delete process.env.WP_STUB_LOCALE;
    await expect(
      verifyPool([localSite()], "backwpup", "local"),
    ).resolves.toBeUndefined();
  });

  test("passes on other English variants", async () => {
    process.env.WP_STUB_LOCALE = "en_GB";
    await expect(
      verifyPool([localSite()], "backwpup", "local"),
    ).resolves.toBeUndefined();
  });

  test("fails with an actionable report on a translated admin", async () => {
    process.env.WP_STUB_LOCALE = "fr_FR";
    const error = await verifyPool([localSite()], "backwpup", "local").catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("Admin locale is English");
    expect(message).toContain("fr_FR");
    // The hint must name the fix, since the cause is a site setting and not a code problem.
    expect(message).toContain("Site Language");
  });

  test("reports a locale it cannot read, rather than assuming English", async () => {
    process.env.WP_STUB_LOCALE = "fail";
    const error = await verifyPool([localSite()], "backwpup", "local").catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      "Could not read the admin locale",
    );
  });

  // A site whose WordPress does not boot must report that, not a second failure about its locale —
  // the locale check only runs once every transport-level check has passed.
  test("is not run when an earlier check already failed", async () => {
    process.env.WP_STUB_INSTALLED = "no";
    process.env.WP_STUB_LOCALE = "fr_FR";
    const error = await verifyPool([localSite()], "backwpup", "local").catch(
      (e: unknown) => e,
    );
    expect((error as Error).message).toContain("WordPress is not installed");
    expect((error as Error).message).not.toContain("Admin locale");
  });
});

test.describe("verifyPool — local transport over a stub wp", () => {
  test("resolves when WP-CLI runs and WordPress is installed", async () => {
    delete process.env.WP_STUB_INFO;
    process.env.WP_STUB_INSTALLED = "yes";
    await expect(
      verifyPool([localSite()], "wp-rocket", "local"),
    ).resolves.toBeUndefined();
  });

  test("throws an actionable report when WordPress is not installed", async () => {
    delete process.env.WP_STUB_INFO;
    process.env.WP_STUB_INSTALLED = "no";
    const error = await verifyPool([localSite()], "wp-rocket", "local").catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("WordPress installed");
    expect(message).toContain("not installed");
    // The WP-CLI step still passed, so it is reported as a green check, not the failure.
    expect(message).toContain("wp-cli 2.10.0");
  });

  test("surfaces wp-cli's stderr when the target is not a WordPress install", async () => {
    delete process.env.WP_STUB_INFO;
    process.env.WP_STUB_INSTALLED = "nowp";
    await expect(
      verifyPool([localSite()], "wp-rocket", "local"),
    ).rejects.toThrow(/does not seem to be a WordPress installation/);
  });

  test("reports a PHP-version bootstrap error as unusable, not 'not installed'", async () => {
    // The real-world false negative: WordPress IS installed, but WP-CLI ran it under a PHP older
    // than WordPress requires, so core printf()s its version error to STDOUT and exit(1) — which
    // by exit code alone is indistinguishable from a genuinely missing install.
    delete process.env.WP_STUB_INFO;
    process.env.WP_STUB_INSTALLED = "phpold";
    const error = await verifyPool([localSite()], "wp-rocket", "local").catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    // Must NOT be misreported as a missing install...
    expect(message).not.toContain("not installed");
    expect(message).not.toContain("database tables are missing");
    // ...must surface WordPress's own message (which core prints to stdout, not stderr)...
    expect(message).toContain("requires at least 7.4");
    // ...and steer the operator toward PHP rather than a phantom missing database.
    expect(message).toMatch(/PHP/);
  });

  test("skips the WordPress check when WP-CLI itself is unavailable", async () => {
    process.env.WP_STUB_INFO = "fail";
    process.env.WP_STUB_INSTALLED = "yes"; // would pass — but must never be reached
    const error = await verifyPool([localSite()], "wp-rocket", "local").catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("WP-CLI");
    // Gated on the WP-CLI check, so the WordPress probe must not run or be reported.
    expect(message).not.toContain("WordPress installed");
  });

  test("silently skips placeholder (.example.test) sites", async () => {
    // Even with a broken WordPress, a placeholder site has no real transport to verify.
    process.env.WP_STUB_INSTALLED = "no";
    await expect(
      verifyPool(
        [localSite("https://shop.example.test")],
        "wp-rocket",
        "local",
      ),
    ).resolves.toBeUndefined();
  });
});
