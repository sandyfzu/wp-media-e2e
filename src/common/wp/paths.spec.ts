import { test, expect } from "@playwright/test";

import {
  PROTECTED_SITE_PATHS,
  assertSafeElevatedTarget,
  isPathSegment,
  normaliseSitePath,
  pathInsideRoot,
  pluginSitePath,
} from "./paths";

/**
 * The shared path guards, tested directly rather than through a caller.
 *
 * These are pure functions over strings, and they are the last check before a command that may run
 * as root, so they are pinned here exhaustively; the modules that use them
 * (`residue.ts`, `ownership.ts`) then only need to prove they *delegate* and that their own wording
 * survives, not to re-test every rule.
 */

/** The message builder these functions take, made visible so a test can assert what it received. */
const describe = (reason: string): string => `rejected: ${reason}`;

test.describe("normaliseSitePath", () => {
  test("accepts a path inside the WordPress root and normalises it", () => {
    expect(normaliseSitePath("wp-content/uploads/backwpup", describe)).toBe(
      "wp-content/uploads/backwpup",
    );
    expect(
      normaliseSitePath("  wp-content/uploads/backwpup/  ", describe),
    ).toBe("wp-content/uploads/backwpup");
    expect(
      normaliseSitePath("wp-content/./uploads/x/../backwpup", describe),
    ).toBe("wp-content/uploads/backwpup");
  });

  // The realistic config typo, and the one worth guarding: dropping the last segment would delete
  // every media file on the site rather than one plugin's directory.
  test("rejects every directory WordPress itself owns", () => {
    for (const path of PROTECTED_SITE_PATHS) {
      expect(() => normaliseSitePath(path, describe), path).toThrow(
        /WordPress itself owns/,
      );
    }
  });

  test("a trailing slash cannot smuggle a protected path past the check", () => {
    expect(() => normaliseSitePath("wp-content/uploads/", describe)).toThrow(
      /WordPress itself owns/,
    );
  });

  // Core replaces these on every update, so nothing below them is ever a plugin's — and a family
  // pattern could otherwise reach `wp-admin/css`.
  test("rejects anything inside core's own directories, however it is spelled", () => {
    for (const path of [
      "wp-admin/css",
      "wp-includes/js/x",
      "wp-content/../wp-admin/images",
    ]) {
      expect(() => normaliseSitePath(path, describe), path).toThrow(
        /WordPress core replaces on every update/,
      );
    }
    expect(normaliseSitePath("wp-content/wp-admin-backups", describe)).toBe(
      "wp-content/wp-admin-backups",
    );
  });

  test("rejects anything that is not a path below the root", () => {
    expect(() => normaliseSitePath("", describe)).toThrow(/is empty/);
    // Pinned in full: this clause moved out of `residue.ts` and was reworded from "residue paths"
    // to "site paths" when the rule became shared, so it is the one message the extraction changed.
    expect(() => normaliseSitePath("/etc", describe)).toThrow(
      /it is absolute, and site paths are resolved against the site's WordPress root/,
    );
    expect(() => normaliseSitePath(".", describe)).toThrow(
      /WordPress root itself/,
    );
    expect(() => normaliseSitePath("..", describe)).toThrow(
      /WordPress root itself/,
    );
    expect(() => normaliseSitePath("../../etc", describe)).toThrow(/escapes/);
    expect(() => normaliseSitePath("wp-content/../..", describe)).toThrow(
      /WordPress root/,
    );
    expect(() => normaliseSitePath("wp-content\\uploads", describe)).toThrow(
      /backslash/,
    );
  });

  // The caller owns the wording, so the reason has to reach it intact — that is the whole contract
  // between this module and the ones that use it.
  test("hands the caller the rule that was broken, and throws its message verbatim", () => {
    let seen: string | undefined;
    expect(() =>
      normaliseSitePath("/etc", (reason) => {
        seen = reason;
        return "[wp/example] my own wording";
      }),
    ).toThrow("[wp/example] my own wording");
    expect(seen).toMatch(/absolute/);
  });
});

test.describe("isPathSegment", () => {
  test("accepts one plain name, dots and all", () => {
    for (const name of [
      "backwpup-pro",
      "job.json",
      ".htaccess",
      "a..b",
      "...",
    ]) {
      expect(isPathSegment(name), name).toBe(true);
    }
  });

  // Each of these would lead somewhere other than a name inside the directory it is joined onto.
  test("refuses nothing, the directory itself, its parent, and anything holding a separator", () => {
    for (const name of ["", ".", "..", "a/b", "/a", "a/", "a\\b", "..\\evil"]) {
      expect(isPathSegment(name), name).toBe(false);
    }
  });
});

test.describe("pluginSitePath", () => {
  test("composes the path a plugin's files live at", () => {
    expect(pluginSitePath("backwpup-pro")).toBe(
      "wp-content/plugins/backwpup-pro",
    );
  });

  // The result is composed into a path a privileged `chown -R` acts on, and `posix.join` would
  // resolve `..` straight back out into a directory WordPress owns.
  test("refuses a slug that is not a single segment", () => {
    for (const bad of [
      "",
      ".",
      "..",
      "a/b",
      "../evil",
      "wp-content/plugins",
      "a\\b",
    ]) {
      expect(() => pluginSitePath(bad), bad).toThrow(
        /not a usable plugin slug/,
      );
    }
  });

  // The composed path must survive the guard every privileged caller runs it through.
  test("produces a path the site-path guard accepts", () => {
    expect(normaliseSitePath(pluginSitePath("backwpup-pro"), describe)).toBe(
      "wp-content/plugins/backwpup-pro",
    );
  });
});

test.describe("pathInsideRoot", () => {
  test("gives a path inside the root relative to it", () => {
    expect(
      pathInsideRoot("/var/www/site/wp-content/uploads/x", "/var/www/site/"),
    ).toBe("wp-content/uploads/x");
    expect(pathInsideRoot("/var/www/site/wp-content/", "/var/www/site")).toBe(
      "wp-content",
    );
  });

  test("normalises both halves first, so `..` cannot lead out of the root", () => {
    expect(
      pathInsideRoot("/var/www/site/wp-content/../../etc", "/var/www/site/"),
    ).toBeUndefined();
    expect(
      pathInsideRoot("/var/www/./site//wp-content", "/var/www/site/./"),
    ).toBe("wp-content");
  });

  test("refuses a sibling that merely shares the root as a string prefix", () => {
    expect(
      pathInsideRoot("/var/www/site2/wp-content", "/var/www/site"),
    ).toBeUndefined();
  });

  test("refuses the root itself, and anything outside it", () => {
    expect(pathInsideRoot("/var/www/site/", "/var/www/site")).toBeUndefined();
    expect(pathInsideRoot("/tmp/elsewhere", "/var/www/site")).toBeUndefined();
  });

  test("handles a root of /", () => {
    expect(pathInsideRoot("/srv/x", "/")).toBe("srv/x");
    expect(pathInsideRoot("/", "/")).toBeUndefined();
  });

  // Both are what a site answers with, so a relative one is an answer that went wrong.
  test("refuses a relative path or root", () => {
    expect(pathInsideRoot("a/b", "a")).toBeUndefined();
    expect(pathInsideRoot("/var/www/site/x", "var/www/site")).toBeUndefined();
  });
});

test.describe("assertSafeElevatedTarget", () => {
  /**
   * The guard as a thunk, which is the shape `expect(...).toThrow()` needs. Wrapping it here keeps
   * every case below a single readable line instead of a nested arrow per assertion.
   */
  const guard =
    (target: string, root: string, message = describe) =>
    (): void => {
      assertSafeElevatedTarget(target, root, message);
    };

  test("accepts a target inside a plausible site root", () => {
    expect(
      guard(
        "/var/www/example.test/wp-content/uploads/backwpup",
        "/var/www/example.test",
      ),
    ).not.toThrow();
  });

  test("tolerates a trailing slash on the root", () => {
    expect(
      guard("/var/www/example.test/wp-content/x", "/var/www/example.test/"),
    ).not.toThrow();
  });

  test("refuses a relative root", () => {
    expect(guard("var/www/x", "var/www")).toThrow(/not an absolute path/);
  });

  // `/tmp` and `/` are real directories, so nothing else would stop a privileged command aimed at
  // them; the depth rule is what does.
  test("refuses a filesystem or top-level root", () => {
    expect(guard("/tmp/x", "/tmp")).toThrow(/top-level system directory/);
    expect(guard("/x", "/")).toThrow(/top-level system directory/);
  });

  test("refuses a target that does not resolve inside the root", () => {
    expect(guard("/etc/passwd", "/var/www/example.test")).toThrow(
      /does not resolve inside it/,
    );
  });

  // A prefix match on the string alone would accept this: the sibling directory shares the root's
  // characters but is not inside it.
  test("refuses a sibling directory whose name merely starts with the root", () => {
    expect(
      guard("/var/www/example.test.bak/wp-content", "/var/www/example.test"),
    ).toThrow(/does not resolve inside it/);
  });

  test("throws the caller's message verbatim", () => {
    expect(guard("/tmp/x", "/tmp", () => "[wp/example] mine")).toThrow(
      "[wp/example] mine",
    );
  });
  // The check is on the resolved path, not the string as written. No caller composes one by hand
  // today — every one of them uses `posix.join` — but this is exported, and a guard that only holds
  // for careful callers is not a guard.
  test("rejects a target that escapes the root through ..", () => {
    for (const target of [
      "/var/www/example.test/../../../etc",
      "/var/www/example.test/./x/../../../etc",
      "/var/www/example.test/../example.other/wp-content",
    ]) {
      expect(() => {
        assertSafeElevatedTarget(target, "/var/www/example.test", describe);
      }, target).toThrow(/does not resolve inside it/);
    }
  });

  test("still accepts an unnormalised target that stays inside", () => {
    expect(() => {
      assertSafeElevatedTarget(
        "/var/www/example.test/wp-content/../wp-content/uploads",
        "/var/www/example.test",
        describe,
      );
    }).not.toThrow();
  });
});
