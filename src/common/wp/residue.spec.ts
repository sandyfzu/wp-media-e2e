import { test, expect } from "@playwright/test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SiteResidueRemovalFailedError } from "./errors";
import {
  normaliseResiduePath,
  prepareSiteDataDirs,
  removeSiteResidue,
} from "./residue";
import type { LocalTransport } from "../config/types";

/**
 * Residue removal against a **real** WordPress-root-like directory over the `local` transport —
 * real `rm`, real `test`, real permissions. Nothing is stubbed, because the property that matters
 * ("the files are gone, and we know it") is a filesystem fact, not a command-invocation one.
 */

let wpRoot: string;
let local: LocalTransport;
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

/** Creates a directory under the WordPress root with a file in it, and returns its path. */
function seed(relative: string): string {
  const dir = join(wpRoot, relative);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "archive.tar"), "x");
  return dir;
}

test.beforeEach(() => {
  wpRoot = mkdtempSync(join(tmpdir(), "wp-residue-root-"));
  local = { mode: "local", rootDir: wpRoot };
});

test.afterEach(() => {
  rmSync(wpRoot, { recursive: true, force: true });
});

/**
 * The same site with escalation switched off.
 *
 * Used by every test that pins what removal does when it *cannot* escalate: with elevation allowed,
 * the answer would depend on whether the machine running the suite happens to have passwordless
 * sudo, which is not a property of this code.
 */
function unprivileged(): LocalTransport {
  return { ...local, elevate: false };
}

test.describe("normaliseResiduePath", () => {
  test("accepts a path inside the WordPress root and normalises it", () => {
    expect(normaliseResiduePath("wp-content/uploads/backwpup")).toBe(
      "wp-content/uploads/backwpup",
    );
    expect(normaliseResiduePath("  wp-content/uploads/backwpup/  ")).toBe(
      "wp-content/uploads/backwpup",
    );
    expect(normaliseResiduePath("wp-content/./uploads/x/../backwpup")).toBe(
      "wp-content/uploads/backwpup",
    );
  });

  // The realistic config typo, and the one worth guarding: dropping the last segment would delete
  // every media file on the site rather than one plugin's directory.
  test("rejects a directory WordPress itself owns", () => {
    for (const path of [
      "wp-content",
      "wp-content/uploads",
      "wp-content/plugins",
      "wp-admin",
      "wp-includes",
      "wp-content/uploads/", // trailing slash must not smuggle it past the check
    ]) {
      expect(() => normaliseResiduePath(path), path).toThrow(
        /WordPress itself owns/,
      );
    }
  });

  test("rejects anything that is not a path below the root", () => {
    expect(() => normaliseResiduePath("")).toThrow(/is empty/);
    expect(() => normaliseResiduePath("/etc")).toThrow(/absolute/);
    expect(() => normaliseResiduePath(".")).toThrow(/WordPress root itself/);
    expect(() => normaliseResiduePath("../../etc")).toThrow(/escapes/);
    expect(() => normaliseResiduePath("wp-content/../..")).toThrow(
      /WordPress root/,
    );
    expect(() => normaliseResiduePath("wp-content\\uploads")).toThrow(
      /backslash/,
    );
  });
});

test.describe("removeSiteResidue", () => {
  test("removes each declared path, whole", async () => {
    const backups = seed("wp-content/uploads/backwpup/abc123/backups");
    const restore = seed("wp-content/uploads/backwpup-restore/uploads");

    await removeSiteResidue(local, [
      "wp-content/uploads/backwpup",
      "wp-content/uploads/backwpup-restore",
    ]);

    expect(existsSync(backups)).toBe(false);
    expect(existsSync(restore)).toBe(false);
    expect(existsSync(join(wpRoot, "wp-content/uploads/backwpup"))).toBe(false);
  });

  // The site's own content must survive: the point is to remove one plugin's leftovers, not to
  // reset the install.
  test("leaves everything else alone", async () => {
    seed("wp-content/uploads/backwpup/abc123/backups");
    const media = seed("wp-content/uploads/2026/08");
    const plugins = seed("wp-content/plugins/some-plugin");

    await removeSiteResidue(local, ["wp-content/uploads/backwpup"]);

    expect(existsSync(join(media, "archive.tar"))).toBe(true);
    expect(existsSync(join(plugins, "archive.tar"))).toBe(true);
  });

  // Cleanup runs after every scenario, including ones that never created anything.
  test("is idempotent — a path that is already gone is fine", async () => {
    await expect(
      removeSiteResidue(local, ["wp-content/uploads/backwpup"]),
    ).resolves.toBeUndefined();
    await expect(
      removeSiteResidue(local, ["wp-content/uploads/backwpup"]),
    ).resolves.toBeUndefined();
  });

  test("does nothing at all when the product declares no residue", async () => {
    // Not even a root lookup: an invalid transport would throw if it touched the site.
    const broken = { mode: "local", rootDir: "" } as LocalTransport;
    await expect(removeSiteResidue(broken, [])).resolves.toBeUndefined();
  });

  // A typo must not leave the site half-cleaned, so validation happens before the first `rm`.
  test("validates every path before removing any of them", async () => {
    const good = seed("wp-content/uploads/backwpup/abc123");

    await expect(
      removeSiteResidue(local, [
        "wp-content/uploads/backwpup",
        "wp-content/uploads",
      ]),
    ).rejects.toThrow(/WordPress itself owns/);

    expect(existsSync(good)).toBe(true);
  });

  test("reports what survived, rather than trusting rm's exit code", async () => {
    test.skip(isRoot, "root ignores directory permissions, so rm -rf succeeds");
    const stuck = seed("wp-content/uploads/backwpup/abc123");
    const parent = join(wpRoot, "wp-content/uploads/backwpup");
    chmodSync(parent, 0o500);
    try {
      // Unprivileged on purpose: this pins what removal reports when it cannot escalate. Whether
      // the machine running the suite happens to have passwordless sudo must not decide it.
      const failure = await removeSiteResidue(unprivileged(), [
        "wp-content/uploads/backwpup",
      ]).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(SiteResidueRemovalFailedError);
      expect((failure as SiteResidueRemovalFailedError).paths).toEqual([
        parent,
      ]);
      expect((failure as SiteResidueRemovalFailedError).elevation).toBe(
        "disabled",
      );
      expect(existsSync(stuck)).toBe(true);
    } finally {
      chmodSync(parent, 0o700);
    }
  });

  // One stubborn path must not shield the rest: the disk fills up either way.
  test("still removes the other paths when one cannot be removed", async () => {
    test.skip(isRoot, "root ignores directory permissions, so rm -rf succeeds");
    seed("wp-content/uploads/backwpup/abc123");
    const restore = seed("wp-content/uploads/backwpup-restore/uploads");
    const parent = join(wpRoot, "wp-content/uploads/backwpup");
    chmodSync(parent, 0o500);
    try {
      await expect(
        removeSiteResidue(unprivileged(), [
          "wp-content/uploads/backwpup",
          "wp-content/uploads/backwpup-restore",
        ]),
      ).rejects.toThrow(SiteResidueRemovalFailedError);

      expect(existsSync(restore)).toBe(false);
    } finally {
      chmodSync(parent, 0o700);
    }
  });
});

/**
 * The escalation policy — unprivileged first, privileged only for what survived.
 *
 * Exercised against a fake `sudo` on `PATH` that hands back the one privilege these tests take away
 * (write access to a target's parent) and records every argv it was given. It is not a stand-in for
 * real root; it exists so the *policy* can be proved on a machine without passwordless root, and the
 * argv log is what makes "escalated for exactly this path, and no other" checkable.
 */

const FAKE_SUDO = `#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FAKE_SUDO_LOG"
if [ "$FAKE_SUDO_DENY" = "1" ]; then exit 1; fi
[ "$1" = "-n" ] && shift
[ "$1" = "--" ] && shift
if [ "$1" = "true" ]; then exit 0; fi
for arg in "$@"; do target="$arg"; done
chmod u+rwx "$(dirname "$target")" 2>/dev/null
[ -e "$target" ] && chmod -R u+rwX "$target" 2>/dev/null
exec "$@"
`;

test.describe("removeSiteResidue — escalation", () => {
  let sudoDir: string;
  let originalPath: string | undefined;
  let sudoLog: string;

  test.beforeEach(() => {
    sudoDir = mkdtempSync(join(tmpdir(), "wp-fake-sudo-"));
    writeFileSync(join(sudoDir, "sudo"), FAKE_SUDO);
    chmodSync(join(sudoDir, "sudo"), 0o755);
    sudoLog = join(sudoDir, "argv.log");
    originalPath = process.env.PATH;
    process.env.PATH = `${sudoDir}:${originalPath ?? ""}`;
    process.env.FAKE_SUDO_LOG = sudoLog;
  });

  test.afterEach(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    delete process.env.FAKE_SUDO_LOG;
    delete process.env.FAKE_SUDO_DENY;
    rmSync(sudoDir, { recursive: true, force: true });
  });

  /** Every argv the fake sudo was handed, or `[]` when it was never called. */
  const sudoCalls = (): string[] =>
    existsSync(sudoLog)
      ? readFileSync(sudoLog, "utf8")
          .split("\n")
          .filter((line) => line !== "")
      : [];

  // The whole point: the directory a plugin created as the web-server user is removed anyway.
  test("removes what the transport's user could not, and only that", async () => {
    test.skip(
      isRoot,
      "root ignores directory permissions, so nothing is stuck",
    );
    seed("wp-content/uploads/backwpup/abc123");
    seed("wp-content/uploads/backwpup-restore/uploads");
    const stuck = join(wpRoot, "wp-content/uploads/backwpup");
    const easy = join(wpRoot, "wp-content/uploads/backwpup-restore");
    chmodSync(stuck, 0o500);
    try {
      await removeSiteResidue(local, [
        "wp-content/uploads/backwpup",
        "wp-content/uploads/backwpup-restore",
      ]);

      expect(existsSync(stuck), "the stubborn path").toBe(false);
      expect(existsSync(easy), "the removable path").toBe(false);
      // Escalated for the one that needed it, never for the one that did not.
      const elevated = sudoCalls().filter((argv) => argv.includes("rm"));
      expect(elevated.some((argv) => argv.includes(stuck))).toBe(true);
      expect(elevated.some((argv) => argv.includes(easy))).toBe(false);
    } finally {
      if (existsSync(stuck)) chmodSync(stuck, 0o700);
    }
  });

  // A correctly-permissioned host must never run anything as root — not even the probe.
  test("does not escalate, or even probe, when the first pass succeeded", async () => {
    seed("wp-content/uploads/backwpup/abc123");
    await removeSiteResidue(local, ["wp-content/uploads/backwpup"]);

    expect(existsSync(join(wpRoot, "wp-content/uploads/backwpup"))).toBe(false);
    expect(sudoCalls()).toEqual([]);
  });

  test("reports that the host has no sudo to fall back on", async () => {
    test.skip(
      isRoot,
      "root ignores directory permissions, so nothing is stuck",
    );
    seed("wp-content/uploads/backwpup/abc123");
    const stuck = join(wpRoot, "wp-content/uploads/backwpup");
    chmodSync(stuck, 0o500);
    process.env.FAKE_SUDO_DENY = "1";
    try {
      const failure = await removeSiteResidue(local, [
        "wp-content/uploads/backwpup",
      ]).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(SiteResidueRemovalFailedError);
      expect((failure as SiteResidueRemovalFailedError).elevation).toBe(
        "unavailable",
      );
      expect((failure as Error).message).toMatch(/no passwordless `sudo`/);
    } finally {
      chmodSync(stuck, 0o700);
    }
  });

  /**
   * The guard on the half {@link normaliseResiduePath} cannot see. A privileged `rm -rf` is only as
   * well-aimed as the root it is joined to, so an implausible `rootDir` is refused rather than
   * handed to sudo — checked with `/tmp`, a real one-segment directory.
   */
  test("refuses to escalate against a top-level WordPress root", async () => {
    test.skip(
      isRoot,
      "root ignores directory permissions, so nothing is stuck",
    );
    const name = `e2e-elevation-guard-${String(process.pid)}`;
    const parent = join("/tmp", name);
    mkdirSync(join(parent, "inner"), { recursive: true });
    writeFileSync(join(parent, "inner", "file"), "x");
    chmodSync(parent, 0o500);
    try {
      await expect(
        removeSiteResidue({ mode: "local", rootDir: "/tmp" }, [name]),
      ).rejects.toThrow(/top-level system directory/);
      // Refused before sudo was ever handed the path.
      expect(sudoCalls().some((argv) => argv.includes("rm"))).toBe(false);
    } finally {
      chmodSync(parent, 0o700);
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

/**
 * Preparing the product's data directories.
 *
 * The property under test is the one the cell taught us: after this runs, a directory the plugin
 * writes must be writable by **every** user sharing the docroot — not merely by whoever created it.
 * Checked as a mode rather than by simulating two users, because the mode is the whole mechanism.
 */
test.describe("prepareSiteDataDirs", () => {
  /** The permission bits of `path`, as an octal string. */
  const mode = (path: string): string =>
    (statSync(path).mode & 0o777).toString(8).padStart(4, "0");

  test("creates a missing directory open to both users", async () => {
    await prepareSiteDataDirs(local, ["wp-content/uploads/backwpup-restore"]);
    const dir = join(wpRoot, "wp-content/uploads/backwpup-restore");
    expect(existsSync(dir)).toBe(true);
    expect(mode(dir)).toBe("0777");
  });

  // The real shape of the bug: the directory already exists, created by one user under its own
  // umask, and the *other* user cannot write it. Re-opening it is the fix.
  test("re-opens a directory an earlier run left too tight", async () => {
    const dir = seed("wp-content/uploads/backwpup-restore/uploads");
    const target = join(wpRoot, "wp-content/uploads/backwpup-restore");
    chmodSync(target, 0o775);
    expect(mode(target)).toBe("0775");

    await prepareSiteDataDirs(local, ["wp-content/uploads/backwpup-restore"]);

    expect(mode(target)).toBe("0777");
    // Idempotent, not destructive: what an earlier run left is still there.
    expect(existsSync(dir)).toBe(true);
  });

  test("prepares every declared path", async () => {
    await prepareSiteDataDirs(local, [
      "wp-content/uploads/backwpup",
      "wp-content/uploads/backwpup-restore",
    ]);
    for (const path of ["backwpup", "backwpup-restore"]) {
      const dir = join(wpRoot, "wp-content/uploads", path);
      expect(existsSync(dir), path).toBe(true);
      expect(mode(dir), path).toBe("0777");
    }
  });

  // Same guard as removal: a declaration that is not a path below the root never reaches the site.
  test("rejects a path WordPress itself owns, before touching the site", async () => {
    await expect(
      prepareSiteDataDirs(local, ["wp-content/uploads"]),
    ).rejects.toThrow(/WordPress itself owns/);
  });

  test("does nothing at all for a product that declares nothing", async () => {
    await expect(prepareSiteDataDirs(local, [])).resolves.toBeUndefined();
  });

  // Nothing to escalate for on a writable tree: preparation must not reach for privileges it does
  // not need, any more than removal does.
  test("names the command, the path and the elevation state when it cannot be done", async () => {
    test.skip(isRoot, "root ignores directory permissions, so mkdir succeeds");
    const uploads = join(wpRoot, "wp-content/uploads");
    mkdirSync(uploads, { recursive: true });
    chmodSync(uploads, 0o500);
    try {
      await expect(
        prepareSiteDataDirs({ ...local, elevate: false }, [
          "wp-content/uploads/backwpup-restore",
        ]),
      ).rejects.toThrow(
        /could not `mkdir -p .*backwpup-restore`.*elevation: disabled/s,
      );
    } finally {
      chmodSync(uploads, 0o700);
    }
  });
});
