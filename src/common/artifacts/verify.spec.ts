import { test, expect } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import AdmZip from "adm-zip";

import {
  formatFailureReport,
  formatSuccessSummary,
  verifyArtifact,
  verifyResolved,
} from "./verify";
import type { CheckResult } from "../setup/preflight";
import type {
  ArtifactIdentity,
  ArtifactRole,
  ProductArtifacts,
  ResolvedArtifact,
  RoleOutcome,
} from "./types";

/**
 * Exercises the identity preflight against **real zips built in-test** with adm-zip — the only
 * way to prove the central-directory/header inspection end to end. Covers the correct case, each
 * failure mode (wrong product, wrong edition, wrong name, missing main file,
 * malformed/structurally-wrong archives), and the aggregation (a failed resolution never stops
 * another role from being verified).
 */

// ── Expected identities ────────────────────────────────────────────────────────

const WPR: ArtifactIdentity = {
  slug: "wp-rocket",
  mainFile: "wp-rocket.php",
  pluginName: "WP Rocket",
};
const BWU_PRO: ArtifactIdentity = {
  slug: "backwpup-pro",
  mainFile: "backwpup.php",
  pluginName: "BackWPup Pro",
};

// ── Fixtures ───────────────────────────────────────────────────────────────────

let tmp: string;

test.beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "artifact-verify-"));
});
test.afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** A minimal but realistic WordPress plugin main file with the given header values. */
function pluginFile(name: string, version = "1.0.0"): string {
  return `<?php\n/**\n * Plugin Name: ${name}\n * Version: ${version}\n * Description: fixture.\n */\n`;
}

/** Writes a zip of the given entry→content map into the temp dir and returns its path. */
function makeZip(name: string, files: Record<string, string>): string {
  const zip = new AdmZip();
  for (const [entry, content] of Object.entries(files)) {
    zip.addFile(entry, Buffer.from(content, "utf8"));
  }
  const path = join(tmp, name);
  zip.writeZip(path);
  return path;
}

/** Finds a check by name (or `undefined`) — for asserting gated checks did / didn't run. */
function findCheck(
  checks: readonly CheckResult[],
  name: string,
): CheckResult | undefined {
  return checks.find((check) => check.name === name);
}

/** Finds a check by name, failing the test if it is absent. */
function requireCheck(
  checks: readonly CheckResult[],
  name: string,
): CheckResult {
  const check = findCheck(checks, name);
  if (check === undefined) throw new Error(`expected a "${name}" check`);
  return check;
}

// ── verifyArtifact: the correct case ────────────────────────────────────────────

test.describe("verifyArtifact — a correct zip", () => {
  test("passes every check in order and reports the header version", () => {
    const zip = makeZip("wp-rocket-3.17.4.zip", {
      "wp-rocket/wp-rocket.php": pluginFile("WP Rocket", "3.17.4"),
      "wp-rocket/readme.txt": "stable tag: 3.17.4",
    });
    const { checks, headerVersion } = verifyArtifact(zip, WPR);
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(checks.map((c) => c.name)).toEqual([
      "archive readable",
      "single top-level directory",
      "plugin slug",
      "main file",
      "plugin name",
    ]);
    expect(headerVersion).toBe("3.17.4");
  });
});

// ── verifyArtifact: identity mismatches ─────────────────────────────────────────

test.describe("verifyArtifact — identity mismatches", () => {
  test("wrong product: slug and main file fail, name check is gated off", () => {
    // A BackWPup zip passed where WP Rocket is expected.
    const zip = makeZip("backwpup.zip", {
      "backwpup/backwpup.php": pluginFile("BackWPup"),
    });
    const { checks } = verifyArtifact(zip, WPR);

    const slug = requireCheck(checks, "plugin slug");
    expect(slug.ok).toBe(false);
    expect(slug.detail).toContain('expected "wp-rocket"');
    expect(slug.detail).toContain('found "backwpup"');
    // wp-rocket.php does not exist under backwpup/, so the main-file check fails...
    expect(requireCheck(checks, "main file").ok).toBe(false);
    // ...and the name check never runs (no main file to read).
    expect(findCheck(checks, "plugin name")).toBeUndefined();
  });

  test("wrong edition: slug fails but the header still reads, so name also fails", () => {
    // A Free zip (backwpup/, "BackWPup") passed where Pro (backwpup-pro/, "BackWPup Pro") is expected.
    const zip = makeZip("backwpup-free.zip", {
      "backwpup/backwpup.php": pluginFile("BackWPup"),
    });
    const { checks } = verifyArtifact(zip, BWU_PRO);

    expect(requireCheck(checks, "plugin slug").ok).toBe(false);
    // The main file IS present under the actual dir, so it is read and the header compared.
    expect(requireCheck(checks, "main file").ok).toBe(true);
    const name = requireCheck(checks, "plugin name");
    expect(name.ok).toBe(false);
    expect(name.detail).toContain('expected "BackWPup Pro"');
    expect(name.detail).toContain('found "BackWPup"');
  });

  test("right slug but a masquerading Plugin Name fails the name check", () => {
    const zip = makeZip("masquerade.zip", {
      "backwpup-pro/backwpup.php": pluginFile("BackWPup"), // wrong header under the right dir
    });
    const { checks } = verifyArtifact(zip, BWU_PRO);
    expect(requireCheck(checks, "plugin slug").ok).toBe(true);
    expect(requireCheck(checks, "main file").ok).toBe(true);
    expect(requireCheck(checks, "plugin name").ok).toBe(false);
  });

  test("missing main file fails after a passing slug, gating the name check", () => {
    const zip = makeZip("no-main.zip", {
      "wp-rocket/readme.txt": "no php here",
    });
    const { checks } = verifyArtifact(zip, WPR);
    expect(requireCheck(checks, "plugin slug").ok).toBe(true);
    expect(requireCheck(checks, "main file").ok).toBe(false);
    expect(findCheck(checks, "plugin name")).toBeUndefined();
  });
});

// ── verifyArtifact: tolerated packaging noise ───────────────────────────────────

test.describe("verifyArtifact — tolerated packaging noise", () => {
  test("a macOS __MACOSX sidecar does not break the structure check", () => {
    // Finder's "Compress" adds this beside the payload; WordPress's unzipper skips it, so a
    // hand-zipped `E2E_PLUGIN_ZIP` that installs fine must verify fine.
    const zip = makeZip("mac-sidecar.zip", {
      "wp-rocket/wp-rocket.php": pluginFile("WP Rocket", "3.17.4"),
      "__MACOSX/._wp-rocket": "resource fork",
      "__MACOSX/wp-rocket/._wp-rocket.php": "resource fork",
    });
    const { checks } = verifyArtifact(zip, WPR);
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(requireCheck(checks, "single top-level directory").detail).toBe(
      '"wp-rocket/".',
    );
  });

  test("an archive holding only __MACOSX entries is reported as empty, not as a plugin", () => {
    const zip = makeZip("only-sidecar.zip", { "__MACOSX/._x": "junk" });
    const structure = requireCheck(
      verifyArtifact(zip, WPR).checks,
      "single top-level directory",
    );
    expect(structure.ok).toBe(false);
    expect(structure.detail).toContain("__MACOSX");
  });

  test("a header line that also closes the comment or PHP tag yields the bare value", () => {
    // WordPress's _cleanup_header_comment() drops either terminator; exact-equality must match it.
    for (const [name, main] of [
      ["comment-terminator.zip", "<?php\n/* Plugin Name: WP Rocket */\n"],
      ["php-terminator.zip", "<?php\n# Plugin Name: WP Rocket ?>\n"],
    ] as const) {
      const zip = makeZip(name, { "wp-rocket/wp-rocket.php": main });
      const check = requireCheck(
        verifyArtifact(zip, WPR).checks,
        "plugin name",
      );
      expect(check.ok, `${name}: ${check.detail}`).toBe(true);
    }
  });
});

// ── verifyArtifact: malformed / structurally wrong archives ─────────────────────

test.describe("verifyArtifact — malformed archives", () => {
  test("an unreadable zip fails the first check and stops", () => {
    const path = join(tmp, "corrupt.zip");
    writeFileSync(path, "this is not a zip archive");
    const { checks } = verifyArtifact(path, WPR);
    expect(checks).toHaveLength(1);
    expect(checks[0]?.name).toBe("archive readable");
    expect(checks[0]?.ok).toBe(false);
  });

  test("multiple top-level directories fail the structure check", () => {
    const zip = makeZip("multi.zip", {
      "wp-rocket/wp-rocket.php": pluginFile("WP Rocket"),
      "other/file.txt": "x",
    });
    const { checks } = verifyArtifact(zip, WPR);
    const structure = requireCheck(checks, "single top-level directory");
    expect(structure.ok).toBe(false);
    expect(structure.detail).toMatch(/found .* at the top level/);
    expect(findCheck(checks, "plugin slug")).toBeUndefined();
  });

  test("a file at the archive root fails the structure check", () => {
    const zip = makeZip("rootfile.zip", {
      "wp-rocket.php": pluginFile("WP Rocket"),
    });
    expect(
      requireCheck(
        verifyArtifact(zip, WPR).checks,
        "single top-level directory",
      ).ok,
    ).toBe(false);
  });
});

// ── verifyResolved: aggregation across roles ────────────────────────────────────

const WPR_MANIFEST: ProductArtifacts = {
  project: "wp-rocket",
  defaultRef: { plugin: "develop", previous: "tag:latest-stable" },
  version: { kind: "embedded" },
  edition: { kind: "editionless", identity: WPR },
};

const BWU_MANIFEST: ProductArtifacts = {
  project: "backwpup",
  defaultRef: { plugin: "develop" },
  version: { kind: "required", defaultVersion: { plugin: "9.99.99" } },
  edition: {
    kind: "editionful",
    byEdition: {
      free: {
        variant: "free",
        identity: {
          slug: "backwpup",
          mainFile: "backwpup.php",
          pluginName: "BackWPup",
        },
      },
      pro: { variant: "pro-en", identity: BWU_PRO },
    },
  },
};

/** A resolved-role outcome pointing at a fixture zip, with sensible defaults. */
function resolved(
  role: ArtifactRole,
  zipPath: string,
  extra: Partial<ResolvedArtifact> = {},
): RoleOutcome {
  const artifact: ResolvedArtifact = {
    role,
    slug: "wp-rocket",
    zipPath,
    zipFilename: basename(zipPath),
    source: "default-ref",
    origin: "built",
    resolvedAt: "2026-07-14T00:00:00.000Z",
    ...extra,
  };
  return { role, kind: "resolved", artifact };
}

/** Finds a role's report, failing the test if it is absent. */
function roleOf(
  roles: ReturnType<typeof verifyResolved>["roles"],
  role: ArtifactRole,
) {
  const found = roles.find((r) => r.role === role);
  if (found === undefined) throw new Error(`expected a "${role}" role report`);
  return found;
}

test.describe("verifyResolved — aggregation", () => {
  test("all roles valid → ok, both artifacts collected and keyed by role", () => {
    const zip = makeZip("wpr-good.zip", {
      "wp-rocket/wp-rocket.php": pluginFile("WP Rocket", "3.17.4"),
    });
    const report = verifyResolved(
      [resolved("plugin", zip), resolved("previous", zip)],
      WPR_MANIFEST,
      undefined,
    );
    expect(report.ok).toBe(true);
    expect(report.resolved).toHaveLength(2);
    expect(report.artifacts.plugin).toBeDefined();
    expect(report.artifacts.previous).toBeDefined();
  });

  test("a failed resolution does not stop the other role from verifying", () => {
    const zip = makeZip("wpr-prev.zip", {
      "wp-rocket/wp-rocket.php": pluginFile("WP Rocket", "3.16.5"),
    });
    const report = verifyResolved(
      [
        {
          role: "plugin",
          kind: "failed",
          error: "APVM build failed: boom",
          hint: "check the ref",
        },
        resolved("previous", zip),
      ],
      WPR_MANIFEST,
      undefined,
    );
    expect(report.ok).toBe(false);
    expect(report.roles.map((r) => r.role)).toEqual(["plugin", "previous"]);

    const plugin = roleOf(report.roles, "plugin");
    expect(plugin.checks[0]?.name).toBe("resolved");
    expect(plugin.checks[0]?.ok).toBe(false);
    expect(plugin.checks[0]?.detail).toContain("boom");

    // The previous role was still fully inspected and passed.
    expect(roleOf(report.roles, "previous").checks.every((c) => c.ok)).toBe(
      true,
    );
    expect(report.resolved).toHaveLength(1);
    expect(report.artifacts.plugin).toBeUndefined();
  });
});

// ── Report formatting ────────────────────────────────────────────────────────

test.describe("report formatting", () => {
  test("failure report names the failing role with expected-vs-found and a hint", () => {
    const freeZip = makeZip("bwu-free-on-pro.zip", {
      "backwpup/backwpup.php": pluginFile("BackWPup"),
    });
    const report = verifyResolved(
      [resolved("plugin", freeZip)],
      BWU_MANIFEST,
      "pro",
    );
    expect(report.ok).toBe(false);

    const text = formatFailureReport(report, "backwpup", "pro@nginx");
    expect(text).toContain("did not pass");
    expect(text).toContain('expected "backwpup-pro"');
    expect(text).toContain('found "backwpup"');
    expect(text).toContain("drop the override");
  });

  test("success summary lists each role's filename and version", () => {
    const zip = makeZip("wpr-summary-3.17.4.zip", {
      "wp-rocket/wp-rocket.php": pluginFile("WP Rocket", "3.17.4"),
    });
    const report = verifyResolved(
      [resolved("plugin", zip, { ref: "develop", commit: "abc1234" })],
      WPR_MANIFEST,
      undefined,
    );
    const text = formatSuccessSummary(report, "wp-rocket", "nginx");
    expect(text).toContain("wpr-summary-3.17.4.zip");
    expect(text).toContain("version=3.17.4");
  });
});
