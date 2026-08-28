import { test, expect } from "@playwright/test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SiteResidueRemovalFailedError } from "./errors";
import { resetOwnershipCaches } from "./ownership";
import {
  normaliseResiduePath,
  prepareSiteDataDirs,
  removeSiteResidue,
} from "./residue";
import type { DockerTransport, LocalTransport } from "../config/types";

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

/**
 * The rules themselves live in `./paths.spec.ts`, which pins them exhaustively. What matters *here*
 * is that residue still delegates to them and still reports a rejection in its own vocabulary — a
 * product author who mistypes a declaration must be told what to declare instead, not merely which
 * abstract rule was broken.
 */
test.describe("normaliseResiduePath", () => {
  test("accepts a path inside the WordPress root and normalises it", () => {
    expect(normaliseResiduePath("  wp-content/./uploads/x/../backwpup/ ")).toBe(
      "wp-content/uploads/backwpup",
    );
  });

  test("rejects a directory WordPress itself owns, in residue's own words", () => {
    expect(() => normaliseResiduePath("wp-content/uploads")).toThrow(
      /\[wp\/residue\].*cannot be removed as leftover data.*WordPress itself owns/s,
    );
  });

  test("names the remedy a product author can act on", () => {
    expect(() => normaliseResiduePath("/etc")).toThrow(
      /Declare a path relative to the WordPress root that the product itself created/,
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

  /**
   * "Nothing at all" includes **not resolving the root**, and that is the half a `local` transport
   * cannot prove: its root is the declared string, read without running anything. `docker` resolves
   * its root with `pwd`, so a stubbed `docker` on `PATH` makes the absence of that lookup
   * observable — without it, this passes with the early return deleted.
   */
  test("does nothing at all when the product declares no residue", async () => {
    const binDir = mkdtempSync(join(tmpdir(), "wp-residue-nores-"));
    const log = join(binDir, "calls.log");
    writeFileSync(
      join(binDir, "docker"),
      `#!/bin/sh\necho "$*" >> ${log}\nprintf "%s" /var/www/html\n`,
    );
    chmodSync(join(binDir, "docker"), 0o755);
    const pathBefore = process.env.PATH ?? "";
    process.env.PATH = `${binDir}:${pathBefore}`;

    try {
      const container: DockerTransport = { mode: "docker", container: "wpcli" };
      await expect(removeSiteResidue(container, [])).resolves.toBeUndefined();
      await expect(prepareSiteDataDirs(container, [])).resolves.toBeUndefined();
      expect(existsSync(log), "no command should have been run").toBe(false);
    } finally {
      process.env.PATH = pathBefore;
      rmSync(binDir, { recursive: true, force: true });
    }
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
/**
 * Removal is guarded before **both** passes, not only the privileged one.
 *
 * A symlinked ancestor makes every lexical check agree while `rm -rf` deletes the referent —
 * measured directly: `rm -rf <root>/wp-content/uploads/backwpup` with `uploads` linked outside
 * removed the target from the other location. "Unprivileged" is only a bound while the transport's
 * user is not root, which a container or a root SSH login does not guarantee, and removing another
 * part of the filesystem is wrong at any privilege.
 */
test.describe("removeSiteResidue — a path that resolves out of the root", () => {
  test("is refused before anything is removed", async () => {
    const outside = mkdtempSync(join(tmpdir(), "wp-outside-"));
    mkdirSync(join(outside, "backwpup"), { recursive: true });
    writeFileSync(join(outside, "backwpup", "keep.txt"), "x");
    mkdirSync(join(wpRoot, "wp-content"), { recursive: true });
    symlinkSync(outside, join(wpRoot, "wp-content", "uploads"));

    await expect(
      removeSiteResidue(local, ["wp-content/uploads/backwpup"]),
    ).rejects.toThrow(/outside it/);
    // The measurement that matters: it is still there.
    expect(existsSync(join(outside, "backwpup", "keep.txt"))).toBe(true);
    rmSync(outside, { recursive: true, force: true });
  });
});

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
  /**
   * Preparation escalates too, so it needs the same root guard removal has. Without it a site whose
   * `rootDir` is a top-level directory would get world-writable directories created **as root** at
   * the filesystem root — and teardown would then refuse to remove what setup had created.
   */
  test("refuses to prepare against a top-level WordPress root", async () => {
    try {
      await expect(
        prepareSiteDataDirs({ mode: "local", rootDir: "/tmp" }, [
          "wp-content/uploads/backwpup",
        ]),
      ).rejects.toThrow(/top-level system directory/);
      expect(existsSync("/tmp/wp-content")).toBe(false);
    } finally {
      // Cleaned unconditionally: `/tmp` is shared with the rest of the machine, so a run where the
      // guard *did* fail would otherwise leave a directory that makes every later run fail here —
      // pointing at the guard instead of at the stale state. Observed exactly that during a
      // mutation test.
      rmSync("/tmp/wp-content", { recursive: true, force: true });
    }
  });

  test("rejects a path WordPress itself owns, before touching the site", async () => {
    await expect(
      prepareSiteDataDirs(local, ["wp-content/uploads"]),
    ).rejects.toThrow(/WordPress itself owns/);
  });

  // The "not even a root lookup" half is proven against `docker` in the removal suite above, where
  // resolving the root is an observable command.
  test("does nothing at all for a product that declares nothing", async () => {
    await expect(prepareSiteDataDirs(local, [])).resolves.toBeUndefined();
  });

  /**
   * The root guard is lexical, so it cannot see that a declared path is a **link out of the tree**.
   * `chmod` here may run as root and follows a symlink given as its operand — measured on GNU
   * coreutils 9.4 — so a link left where a data directory belongs would redirect a privileged `0777`
   * at whatever it resolves to. Proven by the mode of the directory it points at, not by the
   * message: unguarded, this test's own `chmod` reaches it even unprivileged.
   */
  test("refuses a path that is a symbolic link, and leaves its target alone", async () => {
    const outside = mkdtempSync(join(tmpdir(), "wp-residue-outside-"));
    chmodSync(outside, 0o700);
    mkdirSync(join(wpRoot, "wp-content/uploads"), { recursive: true });
    symlinkSync(outside, join(wpRoot, "wp-content/uploads/backwpup"));
    try {
      await expect(
        prepareSiteDataDirs(local, ["wp-content/uploads/backwpup"]),
      ).rejects.toThrow(/symbolic link/);
      expect(mode(outside)).toBe("0700");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  /**
   * The mode is a floor; **handing the directory over is the other half**, and it is the half that
   * reaches a subtree — one the plugin's activation just created as WP-CLI, or one an earlier
   * scenario wrote as the web server. Nothing else in this file can observe it: on a developer's
   * machine the transport user already owns the tree, so the correction takes its fast path and runs
   * no command at all. Stubbing `stat`/`id` forces the mismatch a real cell has, and stubbing `sudo`
   * makes the privileged half observable without root.
   */
  test.describe("hands each prepared directory to the site's ownership", () => {
    let binDir: string;
    let logFile: string;
    let realPath: string;

    /** A stub on `PATH` that records its argv and succeeds. */
    function stub(name: string, body: string): void {
      writeFileSync(
        join(binDir, name),
        `#!/usr/bin/env bash\nprintf '%s\\n' "${name} $*" >> "$RESIDUE_LOG"\n${body}\n`,
      );
      chmodSync(join(binDir, name), 0o755);
    }

    /** Every stubbed command run so far, one per line. */
    const ran = (): string[] =>
      existsSync(logFile)
        ? readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean)
        : [];

    test.beforeEach(() => {
      binDir = mkdtempSync(join(tmpdir(), "wp-residue-bin-"));
      logFile = join(binDir, "commands.log");
      process.env.RESIDUE_LOG = logFile;
      // Ownership the transport user does not already have, so the fast path cannot fire. Only
      // `stat`, `id` and `sudo` are stubbed — `mkdir` and `chmod` stay real, so the directories this
      // test asserts on are genuinely created.
      stub("stat", 'printf "%s" "www-data:www-data:33:33"');
      stub(
        "id",
        'printf "%s" "uid=1000(ubuntu) gid=1000(ubuntu) groups=1000(ubuntu),33(www-data)"',
      );
      stub("sudo", "exit 0");
      resetOwnershipCaches();
      realPath = process.env.PATH ?? "";
      process.env.PATH = `${binDir}:${realPath}`;
    });

    test.afterEach(() => {
      process.env.PATH = realPath;
      Reflect.deleteProperty(process.env, "RESIDUE_LOG");
      rmSync(binDir, { recursive: true, force: true });
      resetOwnershipCaches();
    });

    test("recursively, for every declared path", async () => {
      await prepareSiteDataDirs(local, [
        "wp-content/uploads/backwpup",
        "wp-content/uploads/backwpup-restore",
      ]);

      const elevated = ran().filter((line) => line.startsWith("sudo "));
      for (const path of ["backwpup", "backwpup-restore"]) {
        const dir = join(wpRoot, "wp-content/uploads", path);
        // Recursive, and the grant precedes the chown — the ordering `ownership.ts` depends on.
        expect(elevated, path).toContain(
          `sudo -n -- chmod -R -- ug+rwX ${dir}`,
        );
        expect(elevated, path).toContain(
          `sudo -n -- chown -Rh -- www-data:www-data ${dir}`,
        );
        // The unprivileged floor is still applied, independently of the correction succeeding.
        expect(mode(dir), path).toBe("0777");
      }
    });

    /**
     * A host that cannot correct ownership must still get prepared directories: the correction is
     * best-effort by contract, and preparation is not.
     */
    test("without letting a refused correction fail preparation", async () => {
      stub("sudo", 'case "$*" in *chown*) exit 1 ;; esac; exit 0');

      await expect(
        prepareSiteDataDirs(local, ["wp-content/uploads/backwpup"]),
      ).resolves.toBeUndefined();
      expect(mode(join(wpRoot, "wp-content/uploads/backwpup"))).toBe("0777");
    });
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
