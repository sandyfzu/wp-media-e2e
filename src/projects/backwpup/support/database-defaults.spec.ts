import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DATABASE_DEFAULTS_PHP,
  parseDatabaseDefaults,
  setDatabaseDefaultsPhp,
} from "./database-defaults";

/**
 * The database's default character set and collation, read before a restore resets the database and
 * set back after. The PHP is run under a real `php` where one is installed, against a fake `$wpdb`.
 */

const HAS_PHP = spawnSync("php", ["-v"]).status === 0;

test.describe("parseDatabaseDefaults", () => {
  test("reads the pair", () => {
    expect(
      parseDatabaseDefaults(
        '{"charset":"utf8mb4","collation":"utf8mb4_general_ci"}',
      ),
    ).toEqual({ charset: "utf8mb4", collation: "utf8mb4_general_ci" });
  });

  // These names are put into SQL, so anything but a bare name is refused on the way in.
  for (const reply of [
    "",
    "null",
    '{"charset":"utf8mb4"}',
    '{"charset":"utf8mb4","collation":"x; DROP DATABASE y"}',
    '{"charset":"utf8`mb4","collation":"c"}',
  ]) {
    test(`refuses ${JSON.stringify(reply)}`, () => {
      expect(() => parseDatabaseDefaults(reply)).toThrow(/unexpected answer/);
    });
  }
});

test.describe("the snippets", () => {
  test.skip(!HAS_PHP, "no php binary on this machine");

  test("the reading and the setting both parse as PHP", () => {
    for (const php of [
      DATABASE_DEFAULTS_PHP,
      setDatabaseDefaultsPhp({
        charset: "utf8mb4",
        collation: "utf8mb4_general_ci",
      }),
    ]) {
      const result = spawnSync("php", ["-l"], {
        input: `<?php\n${php}`,
        encoding: "utf8",
      });
      expect(result.status, result.stdout + result.stderr).toBe(0);
    }
  });

  /**
   * Run against a fake `$wpdb` that records its queries: the statement is the one intended, the
   * database name is quoted with any backtick doubled, and a name that is not bare never reaches
   * SQL even when the caller skipped the TypeScript-side check.
   */
  function run(
    charset: string,
    collation: string,
    dbName: string,
  ): ReturnType<typeof spawnSync> {
    const dir = mkdtempSync(join(tmpdir(), "bwp-db-defaults-"));
    try {
      const harness = join(dir, "h.php");
      writeFileSync(
        harness,
        `<?php
define( 'DB_NAME', ${JSON.stringify(dbName)} );
define( 'ARRAY_A', 'ARRAY_A' );
class WP_CLI { public static function error( $m ) { fwrite( STDERR, "ERROR $m" ); exit( 1 ); } }
function wp_json_encode( $v ) { return json_encode( $v ); }
class FakeDb {
	public $last_error = '';
	public $queries = [];
	public function query( $q ) { $this->queries[] = $q; return 1; }
	public function prepare( $q, ...$a ) { return vsprintf( str_replace( '%s', "'%s'", $q ), $a ); }
	public function get_row( $q, $o ) { $this->queries[] = $q; return [ 'charset' => 'utf8mb4', 'collation' => 'utf8mb4_general_ci' ]; }
}
$wpdb = new FakeDb();
eval( file_get_contents( $argv[1] ) );
fwrite( STDERR, json_encode( $wpdb->queries ) );
`,
      );
      const snippet = join(dir, "s.php");
      // The TypeScript-side validation is bypassed on purpose: the PHP must refuse on its own.
      writeFileSync(snippet, setDatabaseDefaultsPhp({ charset, collation }));
      return spawnSync("php", [harness, snippet], { encoding: "utf8" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("setting them back alters the site's own database, quoted", () => {
    const result = run("utf8mb4", "utf8mb4_general_ci", "e2e`Simple");
    expect(result.status, String(result.stderr)).toBe(0);
    const queries = JSON.parse(String(result.stderr)) as string[];
    expect(queries[0]).toBe(
      "ALTER DATABASE `e2e``Simple` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci",
    );
  });

  test("setting them back refuses a name that is not bare before any query", () => {
    const result = run("utf8mb4", "x; DROP DATABASE y", "e2eSimple");
    expect(result.status).toBe(1);
    expect(String(result.stderr)).toContain(
      "refusing an unexpected character set or collation name",
    );
  });
});
