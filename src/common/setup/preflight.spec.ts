import { test, expect } from "@playwright/test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { verifyPool, verifySite, warnAboutElevation } from "./preflight";
import { resetOwnershipCaches } from "../wp/ownership";
import type { CheckResult } from "./preflight";
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

/**
 * A real, non-placeholder local site pointing `wp` at `wpRoot`.
 *
 * `elevate: false` by default, and deliberately: pre-flight now probes privileges, and a unit run
 * must not shell out to the real `sudo` on whatever machine happens to be running it — that would
 * make the result depend on the developer's sudoers file and leave failed-auth entries in the
 * system log. Tests that care about elevation set it explicitly.
 */
function localSite(baseURL = "http://localhost:8100"): SiteConfig {
  return {
    baseURL,
    username: "admin",
    password: "admin_password",
    transport: { mode: "local", rootDir: wpRoot, elevate: false },
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
test.beforeEach(() => {
  // Every describe here shares one `wpRoot`, so they share one ownership cache entry too.
  resetOwnershipCaches();
});

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

/**
 * The two informational checks.
 *
 * Neither describes a fault: a site whose ownership cannot be corrected, or which may not elevate,
 * still runs every scenario — it simply cleans up less. So the property under test is that they
 * *report* without ever changing a verdict, and that they run only once the transport itself is
 * known good.
 *
 * Elevation is pinned via `transport.elevate: false` rather than by probing `sudo`, because whether
 * the machine running these tests happens to have passwordless sudo is not a property of this code.
 */
test.describe("verifySite — ownership & elevation reporting", () => {
  test.beforeEach(() => {
    delete process.env.WP_STUB_INFO;
    delete process.env.WP_STUB_LOCALE;
    process.env.WP_STUB_INSTALLED = "yes";
    resetOwnershipCaches();
  });

  /** The named check from a site's results, or `undefined` if it never ran. */
  const check = (
    checks: readonly CheckResult[],
    name: string,
  ): CheckResult | undefined => checks.find((entry) => entry.name === name);

  test("reports both, and neither can fail the site", async () => {
    const result = await verifySite(localSite(), 0);

    expect(check(result.checks, "File ownership")?.ok).toBe(true);
    expect(check(result.checks, "Elevation")?.ok).toBe(true);
    expect(result.checks.every((entry) => entry.ok)).toBe(true);
  });

  test("carries the elevation state as a value, not only as prose", async () => {
    const result = await verifySite(localSite(), 0);

    // The run-level warning reads this rather than parsing a detail string back apart.
    expect(result.elevation).toBe("disabled");
    expect(check(result.checks, "Elevation")?.detail).toMatch(
      /transport\.elevate: false/,
    );
  });

  test("reports an ownership opt-out as the deliberate choice it is", async () => {
    const site = localSite();
    const result = await verifySite(
      { ...site, transport: { ...site.transport, fileOwner: false } },
      0,
    );

    const ownership = check(result.checks, "File ownership");
    expect(ownership?.ok).toBe(true);
    expect(ownership?.detail).toMatch(/transport\.fileOwner: false/);
  });

  /**
   * The one ownership case that **fails** the site, and the exception proves the rule: every other
   * branch describes a property of the *host*, which the suite adapts to. This one is our own
   * configuration being unreadable, and a check that renders an error message beside a green tick is
   * a check nobody acts on. The sites loader rejects the same value, so reaching this at all means
   * the transport was built in code.
   */
  test("fails the site for a fileOwner that cannot be parsed", async () => {
    const site = localSite();
    const result = await verifySite(
      {
        ...site,
        transport: { ...site.transport, fileOwner: "not a valid spec" },
      },
      0,
    );

    expect(check(result.checks, "File ownership")?.ok).toBe(false);
    expect(check(result.checks, "File ownership")?.detail).toMatch(
      /must be "user:group"/,
    );
    // …and it is the only thing wrong: the host itself is fine.
    expect(
      result.checks.filter((entry) => !entry.ok).map((entry) => entry.name),
    ).toEqual(["File ownership"]);
  });

  /**
   * A site that needs a handover it may not perform must be told it **cannot** happen.
   *
   * `planOwnership` deliberately says nothing about privileges, so without folding the elevation
   * answer in, this line reads "will be handed to …" on a host that will never hand anything over —
   * and in the `disabled` case no run-level banner contradicts it, so the report is simply wrong
   * with nothing to catch it.
   *
   * Reaching that branch needs ownership that differs from the runner's, which is what the stubbed
   * `stat`/`id` provide.
   */
  test("says a needed handover cannot happen when privileges are unavailable", async () => {
    const binDir = mkdtempSync(join(tmpdir(), "wp-pf-stub-"));
    const shim = (name: string, body: string): void => {
      writeFileSync(join(binDir, name), `#!/usr/bin/env bash\n${body}\n`);
      chmodSync(join(binDir, name), 0o755);
    };
    shim("stat", 'printf "%s" "www-data:www-data:33:33"');
    shim(
      "id",
      'printf "%s" "uid=1000(ubuntu) gid=1000(ubuntu) groups=1000(ubuntu),33(www-data)"',
    );
    const pathBefore = process.env.PATH ?? "";
    process.env.PATH = `${binDir}:${pathBefore}`;
    resetOwnershipCaches();

    try {
      const result = await verifySite(localSite(), 0);
      const ownership = check(result.checks, "File ownership");

      expect(ownership?.ok).toBe(true);
      expect(ownership?.detail).toMatch(/cannot be/);
      expect(ownership?.detail).toMatch(/elevation is disabled/);
      // …and it must not claim the handover as a future fact.
      expect(ownership?.detail).not.toMatch(/will be handed/);
    } finally {
      process.env.PATH = pathBefore;
      rmSync(binDir, { recursive: true, force: true });
      resetOwnershipCaches();
    }
  });

  // Both run commands on the site, so asking a transport that has already failed would only produce
  // a second way of saying the same thing.
  test("runs neither when the transport itself failed", async () => {
    process.env.WP_STUB_INSTALLED = "no";
    const result = await verifySite(localSite(), 0);

    expect(check(result.checks, "File ownership")).toBeUndefined();
    expect(check(result.checks, "Elevation")).toBeUndefined();
    expect(result.elevation).toBeUndefined();
  });

  test("a site that may not elevate still passes pre-flight", async () => {
    await expect(
      verifyPool([localSite()], "wp-rocket", "local"),
    ).resolves.toBeUndefined();
  });
});

/**
 * The only state that produces the run-level banner, end to end.
 *
 * Everything else about elevation is pinned against `disabled`, which is silent by design — so
 * without this, `verifySite` could stop populating `elevation`, or either caller could stop calling
 * `warnAboutElevation`, and the whole suite would still be green. `sudo` is shimmed rather than
 * real: the answer must not depend on the sudoers file of whatever machine runs the tests.
 */
test.describe("verifySite → warnAboutElevation — the wiring the banner depends on", () => {
  let binDir: string;
  let pathBefore: string;

  const shim = (name: string, body: string): void => {
    writeFileSync(join(binDir, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(binDir, name), 0o755);
  };

  test.beforeEach(() => {
    binDir = mkdtempSync(join(tmpdir(), "wp-pf-elev-"));
    shim("sudo", "exit 1"); // a sudoer who is not passwordless, and never the real binary
    shim("stat", 'printf "%s" "www-data:www-data:33:33"');
    shim(
      "id",
      'printf "%s" "uid=1000(ubuntu) gid=1000(ubuntu) groups=1000(ubuntu),33(www-data)"',
    );
    pathBefore = process.env.PATH ?? "";
    process.env.PATH = `${binDir}:${pathBefore}`;
    resetOwnershipCaches();
  });

  test.afterEach(() => {
    process.env.PATH = pathBefore;
    rmSync(binDir, { recursive: true, force: true });
    resetOwnershipCaches();
  });

  test("carries the unavailable verdict and the pending handover onto the result", async () => {
    const site = localSite();
    const result = await verifySite(
      { ...site, transport: { ...site.transport, elevate: undefined } },
      0,
    );

    const elevation = result.checks.find((entry) => entry.name === "Elevation");
    expect(result.elevation).toBe("unavailable");
    expect(result.ownershipPending).toBe(true);
    // Still not a failure: privileges are a property of the host, not a fault in it.
    expect(elevation?.ok).toBe(true);
  });

  /**
   * The call site, not just the renderer. Deleting `warnAboutElevation(results)` from `verifyPool`
   * leaves every other test in this file green, so this is the only thing standing between a silent
   * refactor and a run that never warns about a fleet it cannot clean up.
   */
  /**
   * The two checks describe one site and must not contradict each other. When ownership could not be
   * read at all, the elevation line may not answer "needs no change here" — the line directly above
   * it has just said the opposite.
   */
  test("does not claim ownership is settled when it could not be read", async () => {
    shim("stat", "exit 1");
    const site = localSite();
    const result = await verifySite(
      { ...site, transport: { ...site.transport, elevate: undefined } },
      0,
    );
    const ownership = result.checks.find((c) => c.name === "File ownership");
    const elevation = result.checks.find((c) => c.name === "Elevation");

    expect(ownership?.detail).toMatch(/Could not be read/);
    expect(elevation?.detail).not.toMatch(/needs no change/);
    expect(elevation?.detail).toMatch(
      /ownership normalization will be incomplete/,
    );
  });

  test("and pool verification actually prints it", async () => {
    const printed: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]): void => {
      printed.push(args.map(String).join(" "));
    };
    try {
      const site = localSite();
      await verifyPool(
        [{ ...site, transport: { ...site.transport, elevate: undefined } }],
        "wp-rocket",
        "local",
      );
    } finally {
      console.warn = realWarn;
    }

    expect(printed.join("\n")).toContain("ELEVATION UNAVAILABLE");
  });

  test("and that result is what makes the banner print", () => {
    const printed: string[] = [];
    warnAboutElevation(
      [
        {
          index: 0,
          baseURL: "http://broken.test",
          transport: { mode: "local", rootDir: "/var/www/broken" },
          checks: [],
          elevation: "unavailable",
          ownershipPending: true,
        },
      ],
      (message) => printed.push(message),
    );

    expect(printed).toHaveLength(1);
    expect(printed[0]).toContain("ELEVATION UNAVAILABLE");
    expect(printed[0]).toContain("http://broken.test");
  });

  // The silent case, asserted rather than assumed: a site that opted out must not produce a banner.
  test("a site that declined privileges produces nothing", () => {
    const printed: string[] = [];
    warnAboutElevation(
      [
        {
          index: 0,
          baseURL: "http://opted-out.test",
          transport: { mode: "local", rootDir: "/var/www/opted-out" },
          checks: [],
          elevation: "disabled",
          ownershipPending: true,
        },
      ],
      (message) => printed.push(message),
    );

    expect(printed).toEqual([]);
  });
});
