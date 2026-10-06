import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RESTORE_DIR_PHP, parseRestoreDirReply } from "./restore-dir";

/**
 * Where BackWPup's restore working directory is, as the installed plugin says.
 *
 * The reply parser is pinned directly; the snippet itself is run under a real `php` against stubs of
 * the few WordPress and plugin functions it calls — its namespaced function name is written through
 * two layers of escaping, which is exactly where a typo would answer "no such directory" forever.
 * Skipped where PHP is not installed; the snippet also runs live on every cell, on every install.
 */

const HAS_PHP = spawnSync("php", ["-v"]).status === 0;

/** The token a stubbed `restore_dir_name()` answers with. */
const NAME = "backwpup-restore-0123456789abcdef0123";

/**
 * Runs {@link RESTORE_DIR_PHP} the way `wp eval` does — evaluated, top-level `return` and all — with
 * or without the plugin's `restore_dir_name()` defined.
 */
function runSnippet(withNamedDir: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "bwp-restore-dir-"));
  try {
    const snippet = join(dir, "snippet.php");
    writeFileSync(snippet, RESTORE_DIR_PHP);
    const harness = join(dir, "harness.php");
    writeFileSync(
      harness,
      `<?php
namespace Inpsyde\\BackWPup\\Infrastructure\\Restore {
${withNamedDir ? `	function restore_dir_name() { return '${NAME}'; }` : ""}
}
namespace {
	define( 'ABSPATH', '/var/www/site/' );
	function wp_upload_dir( $time = null, $create = true, $refresh = false ) {
		if ( $create ) { throw new Exception( 'the snippet must not create the month directory' ); }
		return [ 'basedir' => '/var/www/site/wp-content/uploads/' ];
	}
	function untrailingslashit( $value ) { return rtrim( $value, '/\\\\' ); }
	function wp_json_encode( $value ) { return json_encode( $value, JSON_UNESCAPED_SLASHES ); }
	class BackWPup_File { public static function get_absolute_path( $path ) { return $path; } }
	eval( file_get_contents( $argv[1] ) );
}
`,
    );
    const result = spawnSync("php", [harness, snippet], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test.describe("RESTORE_DIR_PHP", () => {
  test.skip(!HAS_PHP, "no php binary on this machine");

  test("names the directory under the uploads base, beside the WordPress root", () => {
    expect(parseRestoreDirReply(runSnippet(true))).toBe(
      `wp-content/uploads/${NAME}`,
    );
  });

  test("answers null for a build that names no such directory", () => {
    expect(runSnippet(false)).toBe("null");
    expect(parseRestoreDirReply(runSnippet(false))).toBeUndefined();
  });
});

test.describe("parseRestoreDirReply", () => {
  test("gives the directory relative to the root", () => {
    expect(
      parseRestoreDirReply(
        JSON.stringify({
          dir: `/var/www/site/wp-content/uploads/${NAME}`,
          root: "/var/www/site/",
        }),
      ),
    ).toBe(`wp-content/uploads/${NAME}`);
  });

  test("reads null as a build without one", () => {
    expect(parseRestoreDirReply("null")).toBeUndefined();
  });

  // Neither could be removed by a residue path, so preparing it would only leave it behind.
  test("refuses a directory outside the WordPress root", () => {
    expect(() =>
      parseRestoreDirReply(
        JSON.stringify({ dir: `/srv/uploads/${NAME}`, root: "/var/www/site/" }),
      ),
    ).toThrow(/outside the WordPress root/);
  });

  for (const reply of [
    "",
    "PHP Warning: x",
    "{}",
    '{"dir":1,"root":"/"}',
    "[]",
  ]) {
    test(`refuses an answer the snippet does not give: ${JSON.stringify(reply)}`, () => {
      expect(() => parseRestoreDirReply(reply)).toThrow(/unexpected answer/);
    });
  }
});
