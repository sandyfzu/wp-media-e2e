import { evalPhp, phpLiteral } from "../../../common/wp/php";
import { isObject } from "../../../common/guards";
import type { Transport } from "../../../common/config/types";

/**
 * The site database's own default character set and collation — read before `wp backwpup restore`
 * reaches the database, and set back after.
 *
 * The command's database half runs `wp db reset`, which drops and recreates the whole database with
 * the **server's** defaults: `utf8mb4_0900_ai_ci` on `pro@nginx`, against `utf8mb4_general_ci`
 * before (measured). The tables keep theirs from the dump; the database's own default is what
 * changes. Every snippet here boots WordPress without its plugins: core's `$wpdb` is all it needs,
 * and a just-restored plugin printing anything would otherwise corrupt the reply.
 */

/** A database's default character set and collation. */
export interface DatabaseDefaults {
  readonly charset: string;
  readonly collation: string;
}

/** Reads the site's database's defaults from `information_schema`. */
export const DATABASE_DEFAULTS_PHP = `global $wpdb;
echo wp_json_encode( $wpdb->get_row(
	$wpdb->prepare(
		'SELECT DEFAULT_CHARACTER_SET_NAME AS charset, DEFAULT_COLLATION_NAME AS collation FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = %s',
		DB_NAME
	),
	ARRAY_A
) );`;

/** A character set or collation name, as MySQL names them — the only shape put into SQL here. */
const SQL_NAME = /^[A-Za-z0-9_]+$/;

/**
 * Reads {@link DATABASE_DEFAULTS_PHP}'s answer.
 *
 * @param reply - the snippet's output.
 * @throws {@link Error} if it is not a pair of names.
 */
export function parseDatabaseDefaults(reply: string): DatabaseDefaults {
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply);
  } catch {
    parsed = undefined;
  }
  if (
    !isObject(parsed) ||
    typeof parsed.charset !== "string" ||
    typeof parsed.collation !== "string" ||
    !SQL_NAME.test(parsed.charset) ||
    !SQL_NAME.test(parsed.collation)
  ) {
    throw new Error(
      `[backwpup/database-defaults] reading the database's defaults returned an unexpected answer: ` +
        (reply.slice(0, 300) || "(nothing)"),
    );
  }
  return { charset: parsed.charset, collation: parsed.collation };
}

/**
 * The PHP that sets the database's defaults back. The names are validated again inside PHP, so the
 * snippet stays safe whoever builds it; the database name is the site's own `DB_NAME`, quoted.
 *
 * @param defaults - what to set them to.
 */
export function setDatabaseDefaultsPhp(defaults: DatabaseDefaults): string {
  return `global $wpdb;
$charset = ${phpLiteral(defaults.charset)};
$collation = ${phpLiteral(defaults.collation)};
if ( ! preg_match( '/^[A-Za-z0-9_]+$/', $charset ) || ! preg_match( '/^[A-Za-z0-9_]+$/', $collation ) ) {
	WP_CLI::error( 'refusing an unexpected character set or collation name' );
}
$name = '\`' . str_replace( '\`', '\`\`', DB_NAME ) . '\`';
if ( false === $wpdb->query( "ALTER DATABASE {$name} CHARACTER SET {$charset} COLLATE {$collation}" ) ) {
	WP_CLI::error( 'ALTER DATABASE failed: ' . $wpdb->last_error );
}
${DATABASE_DEFAULTS_PHP}`;
}

/**
 * The site's database's default character set and collation.
 *
 * @param transport - the scenario's site.
 * @throws {@link Error} if the site could not be asked, or answered with anything but two names.
 */
export async function readDatabaseDefaults(
  transport: Transport,
): Promise<DatabaseDefaults> {
  return parseDatabaseDefaults(
    await evalPhp(
      transport,
      DATABASE_DEFAULTS_PHP,
      "reading the database's defaults",
      "backwpup/database-defaults",
      { skipPlugins: true },
    ),
  );
}

/**
 * Sets the database's defaults back to `defaults` when a command changed them, and checks they read
 * back so. Costs one read when nothing changed.
 *
 * @param transport - the scenario's site.
 * @param defaults - what they were before the command.
 * @throws {@link Error} if they could not be set back.
 */
export async function restoreDatabaseDefaults(
  transport: Transport,
  defaults: DatabaseDefaults,
): Promise<void> {
  const now = await readDatabaseDefaults(transport);
  if (
    now.charset === defaults.charset &&
    now.collation === defaults.collation
  ) {
    return;
  }
  const after = parseDatabaseDefaults(
    await evalPhp(
      transport,
      setDatabaseDefaultsPhp(defaults),
      "setting the database's defaults back",
      "backwpup/database-defaults",
      { skipPlugins: true },
    ),
  );
  if (
    after.charset !== defaults.charset ||
    after.collation !== defaults.collation
  ) {
    throw new Error(
      `[backwpup/database-defaults] the database's defaults read ${after.charset}/${after.collation} ` +
        `after being set back to ${defaults.charset}/${defaults.collation}.`,
    );
  }
}
